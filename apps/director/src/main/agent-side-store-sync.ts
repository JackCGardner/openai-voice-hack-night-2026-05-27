/**
 * Agent ↔ side-store sync — main-side source of truth for live sub-agents.
 *
 * THE list_agents-blind FIX. `side-store.ts` exposes `writeAgent` /
 * `queueAgentWrite` (one file per agent under
 * `~/.director/sessions/<id>/agents/*.json`) but, prior to this module, had
 * ZERO production callers — so `readAllAgents()` / `listActiveAgents()` /
 * `list_agents` returned nothing while real Codex agents were running. The
 * canonical agent state lived only in the renderer Zustand store, which the
 * main process does not mirror; the voice layer (and any main-side reader)
 * was therefore blind to live agents.
 *
 * This module gives those writers their first real callers: the codex-pool
 * Electron wrapper (`codex-pool.ts`) calls `syncAgentFromCodexEvent(event)`
 * on EVERY `CodexEvent` it forwards to the renderer, upserting an agent
 * snapshot to the side store. After this, `readAllAgents()` reflects reality
 * and the `list_agents` tool can answer "what's running?" from main-local
 * disk state without consulting the renderer or the deep brain.
 *
 * Design:
 *   - `applyCodexEventToAgent(event, prev)` is a PURE mapper (no Electron, no
 *     disk) so the event→record mapping unit-tests headlessly. `prev` is the
 *     last snapshot (or null for a fresh / missed agent); it returns the next
 *     `Agent` snapshot, or `null` when the event carries no agent_id.
 *   - `syncAgentFromCodexEvent(event)` is the stateful wrapper the pool wires
 *     in. It keeps an in-memory `Map<AgentId, Agent>` so the synchronous,
 *     fire-and-forget `emit()` path can read-modify-write without racing an
 *     async disk read, then debounces the persist via `queueAgentWrite`.
 *
 * Like the renderer's `handleCodexEvent`, a missed `agent_started` must never
 * make an agent invisible: any event for an unknown id BACKFILLS a synthetic
 * record from the payload (id-derived name, role-derived accent) rather than
 * dropping the update.
 */

import type { Agent, AgentId, AgentRole, AgentStatus } from '../shared/state.js';
import type { CodexEvent } from '../shared/codex.js';
import { queueAgentWrite } from './side-store.js';

// ─── Caps (mirror renderer store + state-machine.md §2) ──────────────────

const RECENT_FILES_CAP = 3;
const TASK_TRAIL_CAP = 8;

// ─── Accent palette (mirror tool-router IDENTITY + ipcSync ACCENT_FOR_ROLE) ──
// Kept local so this module stays free of a renderer↔main cross-import. The
// canonical create path (agent_started) carries the role; non-started events
// only carry agent_id, so a backfilled record derives its accent from the
// role we have (or the fallback when the role is unknown).

const ACCENT_FOR_ROLE: Record<string, `#${string}`> = {
  frontend: '#E07856',
  backend: '#4A9E9C',
  data: '#C99550',
  design: '#9670A0',
};
const FALLBACK_ACCENT: `#${string}` = '#9AA0A6';

function accentForRole(role: unknown): `#${string}` {
  if (typeof role !== 'string') return FALLBACK_ACCENT;
  return ACCENT_FOR_ROLE[role.toLowerCase()] ?? FALLBACK_ACCENT;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null
    ? (v as Record<string, unknown>)
    : null;
}

/** Prepend new paths, dedupe by string equality, cap. Newest first. */
function mergeRecentFiles(existing: string[], incoming: string[]): string[] {
  if (incoming.length === 0) return existing;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of [...incoming, ...existing]) {
    if (seen.has(p)) continue;
    seen.add(p);
    result.push(p);
    if (result.length >= RECENT_FILES_CAP) break;
  }
  return result;
}

function pushTrail(trail: string[], item: string): string[] {
  const next = [...trail, item];
  return next.length > TASK_TRAIL_CAP
    ? next.slice(next.length - TASK_TRAIL_CAP)
    : next;
}

/**
 * Extract changed file paths from a `file_change` payload. The SDK shape is
 * `payload.item.changes: [{ path, kind }]`; some shapes carry `item.path`
 * directly. Returns newest-first. Mirrors the renderer's `file_change` arm.
 */
function extractChangedPaths(payload: Record<string, unknown>): string[] {
  const item = asObject(payload.item);
  const changes = item && Array.isArray(item.changes) ? item.changes : [];
  const incoming: string[] = [];
  for (let i = changes.length - 1; i >= 0; i -= 1) {
    const change = asObject(changes[i]);
    const path = change ? asString(change.path) : null;
    if (path) incoming.push(path);
  }
  if (incoming.length === 0) {
    const fallback = item ? asString(item.path) : null;
    if (fallback) incoming.push(fallback);
  }
  return incoming;
}

/**
 * Synthesize a fresh `Agent` snapshot. Used for the `agent_started` rich
 * create AND for backfilling a record when a non-started event arrives for an
 * id we've never seen (missed `agent_started`). `at` seeds `dispatchedAt`.
 */
function freshAgent(
  id: AgentId,
  opts: {
    name?: string | null;
    role?: string | null;
    currentTask?: string | null;
    worktreePath?: string | null;
    status?: AgentStatus;
    at?: number;
  },
): Agent {
  const role = (asString(opts.role) ?? 'Frontend') as AgentRole;
  const task = asString(opts.currentTask);
  return {
    id,
    name: asString(opts.name) ?? id,
    role,
    accentColor: accentForRole(role),
    status: opts.status ?? 'working',
    currentTask: task,
    taskTrail: task ? [task] : [],
    recentFiles: [],
    blocker: null,
    worktreePath: asString(opts.worktreePath),
    codexThreadId: null,
    dispatchedAt: typeof opts.at === 'number' ? opts.at : Date.now(),
    finishedAt: null,
  };
}

/**
 * PURE mapper: given a `CodexEvent` and the prior agent snapshot (or null),
 * return the next snapshot to persist — or `null` when the event has no usable
 * `agent_id` (nothing to write).
 *
 * Mirrors the renderer's `handleCodexEvent` mapping so the on-disk record and
 * the renderer store agree. Defensive: tolerates missing / wrong-typed payload
 * fields without throwing (a torn event must never break a dispatch).
 *
 * Backfill contract: when `prev` is null and the event is NOT `agent_started`,
 * we still synthesize a record from whatever the payload carries so a missed
 * `agent_started` never leaves the agent invisible to `list_agents`.
 */
export function applyCodexEventToAgent(
  event: CodexEvent,
  prev: Agent | null,
): Agent | null {
  if (!event || typeof event !== 'object') return prev;
  const id = asString(event.agent_id);
  if (!id) return prev;
  const payload = asObject(event.payload) ?? {};
  const at = typeof event.at === 'number' ? event.at : Date.now();

  switch (event.type) {
    case 'agent_started': {
      const name = asString(payload.name) ?? id;
      const role = asString(payload.role);
      const task = asString(payload.task);
      const worktree = asString(payload.worktree);
      if (!prev) {
        return freshAgent(id, {
          name,
          role,
          currentTask: task,
          worktreePath: worktree,
          status: 'working',
          at,
        });
      }
      // Re-create over an existing record (rare): keep history, refresh the
      // live fields the create carries.
      return {
        ...prev,
        name,
        role: (role ?? prev.role) as AgentRole,
        accentColor: role ? accentForRole(role) : prev.accentColor,
        status: 'working',
        currentTask: task ?? prev.currentTask,
        taskTrail:
          task && task !== prev.currentTask
            ? pushTrail(prev.taskTrail, task)
            : prev.taskTrail,
        worktreePath: worktree ?? prev.worktreePath,
      };
    }

    case 'thread_started': {
      const threadId = asString(payload.thread_id);
      const base = prev ?? freshAgent(id, { at });
      if (!threadId) return base;
      return { ...base, codexThreadId: threadId };
    }

    case 'file_change': {
      const incoming = extractChangedPaths(payload);
      const base = prev ?? freshAgent(id, { at });
      if (incoming.length === 0) return base;
      return { ...base, recentFiles: mergeRecentFiles(base.recentFiles, incoming) };
    }

    case 'agent_message': {
      // Only the completed message text updates the task line (mirrors the
      // renderer). Other phases are noops but still backfill the record.
      const base = prev ?? freshAgent(id, { at });
      const phase = asString(payload.phase);
      if (phase !== 'item.completed') return base;
      const item = asObject(payload.item);
      const text = item ? asString(item.text) : null;
      if (!text) return base;
      return {
        ...base,
        currentTask: text,
        taskTrail: pushTrail(base.taskTrail, text),
      };
    }

    case 'error': {
      const flatMessage = asString(payload.message);
      const item = asObject(payload.item);
      const itemMessage = item ? asString(item.message) : null;
      const message = flatMessage ?? itemMessage ?? 'unknown_error';
      const base = prev ?? freshAgent(id, { at });
      return { ...base, status: 'blocked', blocker: message };
    }

    case 'agent_finished': {
      const base = prev ?? freshAgent(id, { at });
      const aborted = payload.aborted === true;
      const summary = asString(payload.summary);
      return {
        ...base,
        status: aborted ? 'killed' : 'done',
        finishedAt: at,
        currentTask: aborted ? base.currentTask : summary ?? base.currentTask,
        // A finished agent is no longer blocked.
        blocker: aborted ? base.blocker : null,
      };
    }

    case 'agent_hang_suspected': {
      const base = prev ?? freshAgent(id, { at });
      const thresholdMs =
        typeof payload.thresholdMs === 'number' && payload.thresholdMs > 0
          ? payload.thresholdMs
          : 60_000;
      const seconds = Math.round(thresholdMs / 1000);
      return { ...base, blocker: `watchdog: no output ${seconds}s` };
    }

    // Events that don't change the agent record but still keep it alive /
    // backfilled if we somehow missed the create.
    case 'reasoning':
    case 'command_execution':
    case 'tool_call':
    case 'turn_completed':
      return prev ?? freshAgent(id, { at });

    // batch_completed is per-batch, not per-agent — never write a record.
    case 'batch_completed':
      return prev;

    default:
      return prev;
  }
}

// ─── Stateful wrapper (the pool's real caller) ──────────────────────────

/**
 * In-memory mirror of the last snapshot we computed per agent. Lets the
 * synchronous `emit()` path read-modify-write each event without an async
 * disk read (which would race successive events). The side store on disk is
 * the durable copy; this map is the hot working set, written through via
 * `queueAgentWrite` (debounced 100ms in side-store.ts).
 */
const agentSnapshots = new Map<AgentId, Agent>();

/**
 * Upsert the side-store agent record for a single `CodexEvent`. Called by the
 * codex-pool wrapper's `emit()` for EVERY event. Fire-and-forget + fully
 * defensive: any failure is logged, never thrown (event forwarding to the
 * renderer must not depend on this side effect succeeding).
 *
 * Returns the snapshot it persisted (or null when the event produced no
 * write) so callers / tests can assert the mapping.
 */
export function syncAgentFromCodexEvent(event: CodexEvent): Agent | null {
  try {
    const id = asString(event?.agent_id);
    if (!id) return null;
    const prev = agentSnapshots.get(id) ?? null;
    const next = applyCodexEventToAgent(event, prev);
    if (!next) return null;
    agentSnapshots.set(id, next);
    queueAgentWrite(next);
    return next;
  } catch (err) {
    console.warn('[agent-side-store-sync] upsert failed', err);
    return null;
  }
}

/** Test-only: drop the in-memory snapshot mirror so cases stay isolated. */
export function _resetAgentSnapshotsForTests(): void {
  agentSnapshots.clear();
}

/** Diagnostic / test peek at the current in-memory snapshot for an agent. */
export function _peekAgentSnapshot(id: AgentId): Agent | null {
  return agentSnapshots.get(id) ?? null;
}
