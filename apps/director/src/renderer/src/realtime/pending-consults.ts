/**
 * Pending-consult tracker (pure) — the renderer's bookkeeping for in-flight
 * async `consult_director` calls.
 *
 * ─── Why this exists ────────────────────────────────────────────────────
 * `consult_director` is fire-and-forget: the foreground model gets
 * `{ status:'thinking', ticketId }` back in <50ms, and the real answer
 * arrives seconds later as a proactive announce (IpcChannel.
 * ToolProactiveAnnounce → App.tsx proactive.onAnnounce). The deep brain
 * (gpt-5.5, full shell) can take 5–30s.
 *
 * The cost-control idle-teardown closes the Realtime peer after 45s of
 * quiescence. If the user asks a question and goes quiet, the teardown can
 * fire WHILE the brain is still thinking — and when the answer finally
 * lands, the peer is gone and the announce is dropped. The user never hears
 * their answer.
 *
 * This tracker is the source of truth for "is a consult in flight?". App.tsx
 * increments it when it observes a `thinking` tool result (carrying a
 * ticketId) and decrements it when the matching announce arrives. While the
 * count is > 0 the client suppresses idle-teardown (client.holdPeer(true));
 * when it drops back to 0, normal teardown resumes (client.holdPeer(false)).
 *
 * ─── Why a Set, not a counter ───────────────────────────────────────────
 * Both the increment and decrement signals can arrive more than once or out
 * of order:
 *   - The model may call `consult_director` and the tool result flows back
 *     through `client.dispatchTool`; that path is observed exactly once per
 *     call, but a buggy/duplicate event must not double-count.
 *   - An announce carries `metadata.ticketId`; a redelivery (or a
 *     reconnect-driven replay) must not drive the count negative.
 *   - Some announces are NOT consult results at all (e.g. the hang watchdog
 *     uses kind:'agent_hang_suspected' with no ticketId) — those must not
 *     decrement anything.
 * Tracking distinct ticketIds in a Set makes add/resolve idempotent and the
 * count can never go negative. This is the load-bearing invariant the unit
 * tests pin.
 *
 * ─── Hold-edge callback ─────────────────────────────────────────────────
 * The tracker fires `onHoldChange(hold)` ONLY on the 0↔>0 transition, so the
 * client's `holdPeer()` is called once per edge rather than on every ticket.
 * This keeps the client free of consult bookkeeping — it just sees "hold" /
 * "release".
 *
 * Pure + framework-free: no React, no Electron, no timers. Fully unit-tested
 * in pending-consults.test.ts.
 */

export type HoldChangeListener = (hold: boolean) => void;

export class PendingConsults {
  /** Distinct in-flight ticketIds. Size > 0 ⇒ a consult is pending. */
  private readonly open = new Set<string>();
  private readonly onHoldChange: HoldChangeListener | undefined;

  /**
   * @param onHoldChange Fired with `true` on the first pending ticket and
   *   with `false` when the last one resolves. NOT fired for intermediate
   *   add/resolve calls that don't change the held edge. Optional — omit for
   *   pure counting in tests.
   */
  constructor(onHoldChange?: HoldChangeListener) {
    this.onHoldChange = onHoldChange;
  }

  /** Number of distinct in-flight consults. */
  get size(): number {
    return this.open.size;
  }

  /** True while ≥1 consult is in flight (i.e. the peer should be held). */
  get held(): boolean {
    return this.open.size > 0;
  }

  /** True if this exact ticket is currently tracked as in-flight. */
  has(ticketId: string): boolean {
    return this.open.has(ticketId);
  }

  /**
   * Register a `thinking` tool result. Idempotent per ticketId. Returns true
   * iff this call took the tracker from empty → non-empty (the hold edge),
   * which is also when `onHoldChange(true)` fires.
   *
   * A missing / empty ticketId is ignored (returns false) — we can only
   * correlate the later announce by ticketId, so an untracked consult would
   * never be released and would pin the peer open forever.
   */
  add(ticketId: string | null | undefined): boolean {
    if (typeof ticketId !== 'string' || ticketId.length === 0) return false;
    if (this.open.has(ticketId)) return false; // duplicate — no edge
    const wasEmpty = this.open.size === 0;
    this.open.add(ticketId);
    if (wasEmpty) {
      this.onHoldChange?.(true);
      return true;
    }
    return false;
  }

  /**
   * Resolve a consult by ticketId (the matching announce arrived). Idempotent
   * + safe for unknown ids: resolving a ticket we never tracked is a no-op.
   * Returns true iff this call took the tracker from non-empty → empty (the
   * release edge), which is also when `onHoldChange(false)` fires.
   */
  resolve(ticketId: string | null | undefined): boolean {
    if (typeof ticketId !== 'string' || ticketId.length === 0) return false;
    if (!this.open.delete(ticketId)) return false; // wasn't tracked — no edge
    if (this.open.size === 0) {
      this.onHoldChange?.(false);
      return true;
    }
    return false;
  }

  /**
   * Drop all in-flight tickets (e.g. on client teardown / unmount). Fires the
   * release edge once if anything was pending so the peer hold is lifted.
   */
  clear(): void {
    if (this.open.size === 0) return;
    this.open.clear();
    this.onHoldChange?.(false);
  }
}

/**
 * Extract a consult ticketId from a proactive-announce payload, or null if the
 * announce isn't a consult result/error (e.g. the hang watchdog). Pure helper
 * so App.tsx and the tests agree on the exact correlation rule.
 *
 * Consult announces carry `metadata.kind` ∈ {'consult_result','consult_error'}
 * and `metadata.ticketId` (see tool-router.ts sendConsultAnnounce). Anything
 * else returns null and must NOT decrement the tracker.
 */
export function consultTicketIdFromAnnounce(payload: {
  metadata?: Record<string, unknown> | undefined;
}): string | null {
  const meta = payload?.metadata;
  if (!meta || typeof meta !== 'object') return null;
  const kind = meta.kind;
  if (kind !== 'consult_result' && kind !== 'consult_error') return null;
  const ticketId = meta.ticketId;
  return typeof ticketId === 'string' && ticketId.length > 0 ? ticketId : null;
}

/**
 * Extract a consult ticketId from a `consult_director` tool result, or null if
 * the result isn't a `thinking` ack. Pure so App.tsx and tests agree on the
 * exact shape. The tool-router returns `{ status:'thinking', ticketId,
 * restated }` (handleConsultDirector); only that shape should increment.
 */
export function thinkingTicketIdFromToolResult(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const o = output as Record<string, unknown>;
  if (o.status !== 'thinking') return null;
  const ticketId = o.ticketId;
  return typeof ticketId === 'string' && ticketId.length > 0 ? ticketId : null;
}
