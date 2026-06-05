/**
 * Async consult ticket registry — the engine behind the fire-and-forget
 * `consult_director` protocol (docs/voice-genui-spec.md §1).
 *
 * The voice layer must never block on deep thought. `consult_director` today
 * is synchronous: `handleConsultDirector` (tool-router.ts:318) awaits
 * `consultDirector` → `runAgentBrain` (gpt-5.5, full shell, maxTurns:40 — 5–30s),
 * so the Realtime turn is blocked the whole consult and slow consults can
 * outlast the data channel. This module makes the consult fire-and-forget:
 *
 *   1. handleConsultDirector validates the prompt, mints a ticket via
 *      `openTicket(prompt, restated)`, kicks `runTicket(...)` WITHOUT awaiting,
 *      and returns `{ status:'thinking', ticketId, restated }` in <50ms.
 *   2. `runTicket` runs the (injected) Brain runner off the voice-return path.
 *      On resolve it `deliver(...)`s the attributed line "On <restated>: <summary>";
 *      on reject it delivers "Couldn't get to the bottom of <restated>.".
 *   3. The ticket is closed (removed from the map) in a `finally` after delivery.
 *
 * Tickets are ephemeral, in-memory only — no disk, no persistence. A process
 * restart drops in-flight consults (acceptable — the user re-asks).
 *
 * This module is intentionally kept OUT of tool-router.ts so the router stays a
 * pure dispatcher and the registry + lifecycle are unit-testable headlessly:
 * the `runner` (Brain) and `deliver` (IPC send) are injected, so no Electron /
 * OpenAI mocking is needed to test the lifecycle.
 *
 * IPC: this module never touches IPC directly. The caller supplies `deliver`,
 * which in production sends `IpcChannel.ToolProactiveAnnounce` (the SAME channel
 * the hang watchdog uses — planner.ts announceAgentHang) to the strip window.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface ConsultTicket {
  /** The raw prompt sent to the Brain. */
  prompt: string;
  /** One-line restatement used in the spoken attribution prefix. */
  restated: string;
  /** Date.now() at dispatch. */
  startedAt: number;
}

/**
 * The payload `deliver` receives once a ticket settles. In production the
 * caller maps this onto a `ProactiveAnnouncePayload`:
 *
 *   success → { text, reason:'agent_done', metadata:{ kind:'consult_result', ticketId } }
 *   error   → { text, reason:'agent_done', metadata:{ kind:'consult_error',  ticketId } }
 *
 * `text` is already fully formed (attribution prefix applied) — the caller
 * should not re-wrap it.
 */
export interface ConsultDelivery {
  ticketId: string;
  restated: string;
  text: string;
  /** Discriminates the two announce metadata kinds for the caller. */
  outcome: 'result' | 'error';
}

/** The injected Brain runner. Returns the spoken-English summary string. */
export type ConsultRunner = (prompt: string) => Promise<{ summary: string }>;

/** The injected delivery sink (production: send the proactive announce IPC). */
export type ConsultDeliver = (payload: ConsultDelivery) => void;

// ─── Restate helper (pure) ─────────────────────────────────────────────────

const RESTATE_MAX_CHARS = 80;

/**
 * Turn the user's raw prompt into a short, human-readable topic label used in
 * the attribution prefix ("On <restated>: …"). v1 is deterministic + cheap:
 * collapse whitespace to one line, strip a leading question-stem / filler, drop
 * a trailing '?' , and clamp to ≤80 chars (word-boundary, with an ellipsis).
 *
 * It is NOT a model call — the spec is explicit: "Do not block on producing a
 * fancy restate." A later pass may have the model pass an explicit `restated`.
 *
 * @example restate("Should we split the API by resource?") -> "split the API by resource"
 * @example restate("how should we structure the auth module")  -> "structure the auth module"
 */
export function restate(prompt: string): string {
  // Collapse any whitespace (incl. newlines) to single spaces, trim ends.
  let s = String(prompt ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return 'that';

  // Strip a leading conversational/question stem so the label reads as a topic
  // ("whether to split…", "structure the auth module") rather than echoing the
  // question grammar. Order matters — longer stems first.
  const STEMS: RegExp[] = [
    /^(?:hey|ok|okay|so|um|uh|well|alright|right)[,\s]+/i,
    // Third-person restatements the foreground model tends to emit as the
    // consult prompt ("the user wants to …", "user is asking about …") —
    // strip so the label is the topic, not "On User wants …".
    /^(?:the\s+)?user\s+(?:wants?|needs?|asked|is\s+asking|would\s+like|wonders?|wishes?)\s+(?:to\s+|for\s+|about\s+|me\s+to\s+|you\s+to\s+|us\s+to\s+|whether\s+)?/i,
    /^(?:can|could|would|will|should)\s+(?:you|we|i)\s+(?:please\s+)?/i,
    /^(?:please\s+)?(?:tell|help|let|show)\s+me\s+(?:about\s+|with\s+|how\s+to\s+)?/i,
    /^(?:what(?:'s| is| are)?|which|how|why|when|where|who)\s+(?:should|do|would|could|can|is|are|the\s+best\s+way\s+to)?\s*(?:we|i|you)?\s*/i,
    /^(?:i\s+(?:want|need|would like)\s+(?:to|you to)\s+)/i,
    /^(?:do you think|what do you think about)\s+/i,
  ];
  for (const re of STEMS) {
    const next = s.replace(re, '');
    // Only accept the strip if the stem actually matched AND it left something
    // meaningful behind (a non-matching `.replace` returns the original, which
    // would otherwise satisfy the length guard and break the loop prematurely).
    if (next !== s && next.trim().length >= 3) {
      s = next.trim();
      break;
    }
  }

  // Drop trailing punctuation that reads oddly mid-sentence ("On split…?: …").
  s = s.replace(/[?!.…]+$/u, '').trim();
  if (!s) return 'that';

  if (s.length <= RESTATE_MAX_CHARS) return s;

  // Clamp to ≤80 chars on a word boundary, append an ellipsis.
  const clipped = s.slice(0, RESTATE_MAX_CHARS);
  const lastSpace = clipped.lastIndexOf(' ');
  const head = (lastSpace > 24 ? clipped.slice(0, lastSpace) : clipped).replace(
    /[\s,;:.…-]+$/u,
    '',
  );
  return `${head}…`;
}

// ─── Attribution text (pure) ────────────────────────────────────────────────

/** The FIXED success line (§1.4). The prefix re-anchors the user, who has kept
 *  talking since the consult started. */
export function resultText(restated: string, summary: string): string {
  return `On ${restated}: ${String(summary ?? '').trim()}`;
}

/** The FIXED error line (§1.5). */
export function errorText(restated: string): string {
  return `Couldn't get to the bottom of ${restated}.`;
}

// ─── Registry ───────────────────────────────────────────────────────────────

const tickets = new Map<string, ConsultTicket>();

function mintTicketId(): string {
  return `consult-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Open a ticket on dispatch. Returns the new `ticketId`. The row stays in the
 * map until the consult settles and is closed (`completeTicket` / `closeTicket`).
 *
 * Overloaded for the two call styles the integration wave may use:
 *   - `openTicket(prompt, restated)` — the lifecycle style (this task).
 *   - `openTicket({ prompt, restated, startedAt? })` — the spec-doc §1.3 row style.
 */
type OpenTicketRow = Omit<ConsultTicket, 'startedAt'> & { startedAt?: number };
export function openTicket(prompt: string, restated?: string): string;
export function openTicket(t: OpenTicketRow): string;
export function openTicket(
  promptOrTicket: string | OpenTicketRow,
  restatedArg?: string,
): string {
  const row: ConsultTicket =
    typeof promptOrTicket === 'string'
      ? {
          prompt: promptOrTicket,
          restated: restatedArg ?? restate(promptOrTicket),
          startedAt: Date.now(),
        }
      : {
          prompt: promptOrTicket.prompt,
          restated: promptOrTicket.restated,
          startedAt: promptOrTicket.startedAt ?? Date.now(),
        };
  const id = mintTicketId();
  tickets.set(id, row);
  return id;
}

/** Look up an in-flight ticket. */
export function getTicket(id: string): ConsultTicket | undefined {
  return tickets.get(id);
}

/** All in-flight tickets, oldest-first (by `startedAt`). */
export function listTickets(): Array<ConsultTicket & { ticketId: string }> {
  return [...tickets.entries()]
    .map(([ticketId, t]) => ({ ticketId, ...t }))
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Remove a ticket from the registry and return the row it held (or `undefined`
 * if it was already gone). Idempotent — a double-close returns `undefined`.
 * Alias: `closeTicket` (spec-doc §1.3 name).
 */
export function completeTicket(id: string): ConsultTicket | undefined {
  const row = tickets.get(id);
  tickets.delete(id);
  return row;
}

/** Spec-doc §1.3 alias for {@link completeTicket}. */
export const closeTicket = completeTicket;

/**
 * Start the async run for an already-open ticket. NON-BLOCKING — it returns
 * `void` immediately and the (injected) `runner` resolves later. On settle it
 * calls `deliver(...)` with the attributed line, then `completeTicket(ticketId)`
 * in a `finally`.
 *
 * Errors thrown synchronously inside `runner` (before it returns a promise) are
 * caught too: `runTicket` wraps the call so the voice-return path is never hit
 * by a throw, regardless of how the runner misbehaves.
 *
 * If `ticketId` is unknown (already closed / never opened), this no-ops with a
 * warning — there is nothing to attribute or close.
 */
export function runTicket(
  ticketId: string,
  runner: ConsultRunner,
  deliver: ConsultDeliver,
): void {
  const ticket = tickets.get(ticketId);
  if (!ticket) {
    console.warn(`[consult-tickets] runTicket: unknown ticketId ${ticketId} — dropping`);
    return;
  }
  const { restated } = ticket;

  // Defer the runner invocation behind Promise.resolve() so even a synchronous
  // throw inside `runner` lands in the .catch below rather than propagating to
  // the (synchronous) caller on the voice-return path.
  Promise.resolve()
    .then(() => runner(ticket.prompt))
    .then((res) => {
      const summary = (res?.summary ?? '').trim();
      // An empty summary is treated as a soft failure — the user gets the
      // graceful "couldn't get to the bottom" line rather than a bare "On X:".
      if (!summary) {
        deliver({
          ticketId,
          restated,
          text: errorText(restated),
          outcome: 'error',
        });
        return;
      }
      deliver({
        ticketId,
        restated,
        text: resultText(restated, summary),
        outcome: 'result',
      });
    })
    .catch((err) => {
      console.warn(
        `[consult-tickets] ticket ${ticketId} (${restated}) failed`,
        err instanceof Error ? err.message : err,
      );
      deliver({
        ticketId,
        restated,
        text: errorText(restated),
        outcome: 'error',
      });
    })
    .finally(() => {
      completeTicket(ticketId);
    });
}

/**
 * Convenience for the common dispatch path: open a ticket and immediately kick
 * its async run. Returns `{ ticketId, restated }` synchronously so the caller
 * can build the `{ status:'thinking', ticketId, restated }` tool result.
 *
 * Production usage (tool-router handleConsultDirector):
 *   const { ticketId, restated } = dispatchConsult(
 *     args.prompt,
 *     (prompt) => consultDirector({ ...args, prompt }, ctx.stripWindow),  // runner
 *     (p) => sendProactiveAnnounce(ctx.stripWindow, p),                   // deliver
 *   );
 *   return { ok:true, callId, output:{ status:'thinking', ticketId, restated }, latencyMs };
 */
export function dispatchConsult(
  prompt: string,
  runner: ConsultRunner,
  deliver: ConsultDeliver,
  restatedHint?: string,
): { ticketId: string; restated: string } {
  const restated = restatedHint?.trim() || restate(prompt);
  const ticketId = openTicket(prompt, restated);
  runTicket(ticketId, runner, deliver);
  return { ticketId, restated };
}

/** Test/diagnostic hook — clear the in-flight map between tests. */
export function _resetTicketsForTests(): void {
  tickets.clear();
}
