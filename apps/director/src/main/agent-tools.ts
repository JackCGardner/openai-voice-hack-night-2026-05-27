/**
 * Agent tools — main-side handlers + tool defs for the agent-visibility and
 * real-dispatch surface (docs/voice-genui-spec.md §3).
 *
 * This module is kept separate from `tool-router.ts` so the router stays a
 * thin dispatcher: the router's switch calls `handleListAgents(req)` /
 * `dispatchAgentReal(args, ...)` and these own the logic + are unit-testable
 * headlessly.
 *
 * Three exports:
 *   - `listAgentsToolDef` — the `list_agents` Realtime tool def object the
 *     Integrate wave appends to `realtimeToolDefs()` (shared/realtime.ts).
 *   - `handleListAgents(req)` — synchronous Realtime tool handler returning
 *     `{ agents: ListAgentsItem[] }` from the side-store (§3.1). Wrapped in a
 *     `ToolCallResponse` so it drops into the `tool-router` switch unchanged.
 *   - `dispatchAgentReal(args, ...)` — drives the REAL `codex-pool`
 *     (`dispatchAgent`) to spawn an actual Codex subprocess (§3.3). This is the
 *     ONLY dispatch path: `tool-router.ts handleDispatchAgentMock`
 *     unconditionally calls it (no `DIRECTOR_REAL_AGENTS` env gate / no sim
 *     fallback — both removed), keeping the `dispatch_agent_mock` tool name on
 *     the wire for backwards compatibility while the behavior is fully real.
 */

import type { ToolCallRequest, ToolCallResponse } from '../shared/ipc.js';
import type { AgentRole } from '../shared/state.js';
import { listActiveAgents, toListAgentsItem, type ListAgentsItem } from './agent-registry.js';

// ─── list_agents — synchronous "what's running?" tool (§3.1) ───────────────

/**
 * The `list_agents` Realtime tool definition. The Integrate wave appends this
 * to `realtimeToolDefs()` (shared/realtime.ts) and adds
 * `RealtimeToolName.ListAgents = 'list_agents'`. Wording is verbatim from
 * docs/voice-genui-spec.md §3.1 (gpt-realtime follows narrow wording strictly).
 */
export const listAgentsToolDef: Record<string, unknown> = {
  type: 'function',
  name: 'list_agents',
  description:
    "List the sub-agents currently running and what each is doing. Use to answer 'what's happening?' / 'what's running?' / status questions — never consult the planner for this.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

/** Return shape of the `list_agents` tool (§3.1). */
export interface ListAgentsOutput {
  agents: ListAgentsItem[];
}

/**
 * Pure handler — read the live agents from the side-store and narrow them to
 * the wire shape. Exposed separately from `handleListAgents` so a unit test
 * can assert the `{ agents }` shape without a `ToolCallRequest` envelope.
 *
 * Never throws — `listActiveAgents()` already swallows read failures and
 * returns `[]`, so the voice layer gets "nothing running" instead of an error.
 */
export async function getListAgentsOutput(): Promise<ListAgentsOutput> {
  const views = await listActiveAgents();
  return { agents: views.map(toListAgentsItem) };
}

/**
 * `list_agents` tool-router handler. Synchronous-ish (one fast side-store
 * read). Slots directly into the `tool-router.ts` switch:
 *
 *   case 'list_agents':
 *     return await handleListAgents(req);
 */
export async function handleListAgents(req: ToolCallRequest): Promise<ToolCallResponse> {
  const startedAt = Date.now();
  try {
    const output = await getListAgentsOutput();
    return {
      ok: true,
      callId: req.callId,
      output,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    // Defensive belt-and-braces — getListAgentsOutput shouldn't throw, but a
    // status query must never fail the voice turn. Degrade to empty list.
    console.warn('[agent-tools] handleListAgents failed', err);
    return {
      ok: true,
      callId: req.callId,
      output: { agents: [] } satisfies ListAgentsOutput,
      latencyMs: Date.now() - startedAt,
    };
  }
}

// ─── Real dispatch — drive the real codex-pool (the only dispatch path) ────

export interface RealDispatchArgs {
  /** Canonical agent id (already resolved by the router's `resolveIdentity`). */
  agentId: string;
  name: string;
  role: AgentRole;
  task: string;
  /**
   * Absolute path to the target repo — the Brain's roaming cwd /
   * `DIRECTOR_PROJECT_ROOT` / `$HOME` (§3.3 + §5: agents work where the user is
   * working; no project picker). The router resolves this via
   * `resolveTargetRepo()`.
   */
  targetRepo: string;
  baseBranch?: string;
  batchId?: string;
  /**
   * finish-spec §B.3 isolation mode (default `false` = shared cwd). Threaded
   * through to `dispatchAgent`/`dispatchAgentCore` so the realtime path can
   * opt into worktree isolation the same way the brain's `dispatch_agent`
   * tool does. Append-only field; omitted → shared mode.
   */
  useWorktree?: boolean;
}

export type RealDispatchResult =
  | { ok: true; agent_id: string; worktree: string; branch: string }
  | { ok: false; error: string };

/**
 * The codex-pool dispatch driver. Typed as the subset of `codex-pool`'s
 * `dispatchAgent` signature we need, so this module never imports the Electron
 * wrapper directly — the router injects the real `dispatchAgent` + the live
 * `sessionId` (from `side-store.getSessionId()`). Keeps `agent-tools` headless-
 * testable (inject a fake driver; no Electron, no Codex SDK).
 */
export type DispatchAgentDriver = (
  req: {
    agentId: string;
    name: string;
    role: AgentRole;
    task: string;
    targetRepo: string;
    baseBranch?: string;
    batchId?: string;
    useWorktree?: boolean;
  },
  sessionId: string,
) => Promise<
  | { ok: true; agentId: string; worktree: string; branch: string }
  | { ok: false; error: string }
>;

/**
 * Dispatch a REAL Codex sub-agent through the codex-pool (§3.3). Returns
 * immediately with `{ ok, agent_id, worktree, branch }` (the pool's
 * `runStreamed` loop runs detached and emits `codex.event`s, which already
 * flow `codex-pool.emit → strip CodexEvent → ipcSync.handleCodexEvent →
 * commands.*` — the Hive + agent_pod light up with real progress for free).
 *
 * IMPORTANT (§3.3 step 3): the caller must NOT push the synthetic `addAgent`
 * patch or `startSim` when real agents are on — the pool's
 * `agent_started` event maps to `commands.addAgent` via `ipcSync`. This
 * function deliberately does no store patching; that's the router's job
 * (skip the manual patch in the real branch).
 *
 * `dispatch` is injected (the router passes `codex-pool.dispatchAgent`) so
 * this stays Electron-free and unit-testable.
 */
export async function dispatchAgentReal(
  args: RealDispatchArgs,
  sessionId: string,
  dispatch: DispatchAgentDriver,
): Promise<RealDispatchResult> {
  if (!args?.task || typeof args.task !== 'string') {
    return { ok: false, error: 'missing task prompt' };
  }
  if (!args?.targetRepo) {
    return { ok: false, error: 'missing targetRepo' };
  }
  if (!sessionId) {
    return { ok: false, error: 'no active session' };
  }
  const ack = await dispatch(
    {
      agentId: args.agentId,
      name: args.name,
      role: args.role,
      task: args.task,
      targetRepo: args.targetRepo,
      ...(args.baseBranch ? { baseBranch: args.baseBranch } : {}),
      ...(args.batchId ? { batchId: args.batchId } : {}),
      // Thread worktree mode only when explicitly opted in, so callers that
      // don't set it produce the exact same request shape as before (shared
      // mode is the pool default). finish-spec §B.3.
      ...(args.useWorktree ? { useWorktree: true } : {}),
    },
    sessionId,
  );
  if (!ack.ok) {
    return { ok: false, error: ack.error };
  }
  return {
    ok: true,
    agent_id: ack.agentId,
    worktree: ack.worktree,
    branch: ack.branch,
  };
}

/**
 * Resolve the target repo for a real dispatch (finish-spec §B.1). Agents are
 * dispatched into wherever the work actually is. Precedence, highest first:
 *
 *   1. `explicit`   — a directory the caller already resolved (e.g. the
 *                     brain's `dispatch_agent` tool passes its own target).
 *   2. `brainCwd`   — the brain's live roaming-shell cwd (`getBrainCwd()`),
 *                     so a voice "send Maya in" lands in the SAME directory
 *                     the brain just `mkdir`'d/`cd`'d into. THIS is the key
 *                     change from the old `$HOME`-only resolver: the realtime
 *                     `dispatch_agent_mock` path no longer ignores where the
 *                     brain roamed.
 *   3. DIRECTOR_PROJECT_ROOT — the optional static project hint.
 *   4. `home`       — the final fallback ($HOME).
 *
 * `home` is required; the rest are optional/injectable so this stays
 * Electron-free + unit-testable (no `agent-brain` import here — the caller
 * passes `brainCwd: getBrainCwd()`).
 */
export function resolveTargetRepo(opts: {
  explicit?: string;
  brainCwd?: string;
  home: string;
}): string {
  if (opts.explicit && opts.explicit.length > 0) return opts.explicit;
  if (opts.brainCwd && opts.brainCwd.length > 0) return opts.brainCwd;
  const hint = process.env.DIRECTOR_PROJECT_ROOT;
  if (hint && hint.length > 0) return hint;
  return opts.home;
}
