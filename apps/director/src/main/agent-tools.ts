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
 *     (`dispatchAgent`) instead of the sim mock (§3.3). Gated by
 *     `DIRECTOR_REAL_AGENTS` (see `useRealAgents()`); the router branches on it
 *     inside `handleDispatchAgentMock`, keeping the same tool name on the wire.
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

// ─── Real dispatch — drive the real codex-pool, not the sim mock (§3.3) ────

/**
 * Flag (spec §3.3): `DIRECTOR_REAL_AGENTS`. **Default OFF** (mock/sim) for the
 * hackathon demo; `DIRECTOR_REAL_AGENTS=1` (or `true`) switches
 * `dispatch_agent_mock`'s handler body to drive the real pool. Mirrors the
 * `DIRECTOR_LEGACY_PLANNER` env-flag style used in `planner.ts`.
 *
 * The tool NAME on the Realtime surface stays `dispatch_agent_mock` so the
 * persona + enum are unchanged — only the handler body swaps.
 */
export function useRealAgents(): boolean {
  const raw = process.env.DIRECTOR_REAL_AGENTS;
  return raw === '1' || raw === 'true';
}

/**
 * Flag (spec §4 item 3): `DIRECTOR_DEMO_SIM`. **Default OFF.** Gates whether
 * `dispatch_agent_mock` itself auto-kicks the Mixtape sim timeline on the
 * first dispatch. Historically the router fired the `startSim` patch on every
 * first `dispatch_agent_mock` in ANY session — an implicit demo leak (a real
 * question that dispatched an agent would start the Tokyo-neon timeline).
 *
 * The explicit demo triggers (dev `⌃⌥⌘`/`d` hotkeys, the ChatSurface "Start
 * Mixtape Demo" button) drive `startMixtapeDemo` DIRECTLY in the renderer —
 * they do NOT depend on this flag. So default-OFF removes the implicit leak
 * while keeping the demo fully invokable. Set `DIRECTOR_DEMO_SIM=1` only if you
 * want a bare `dispatch_agent_mock` call to also start the timeline.
 */
export function useDemoSim(): boolean {
  const raw = process.env.DIRECTOR_DEMO_SIM;
  return raw === '1' || raw === 'true';
}

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
 * Resolve the target repo for a real dispatch (§3.3 + §5). Agents are
 * dispatched into wherever the user is currently working — the roaming cwd /
 * `DIRECTOR_PROJECT_ROOT` hint, defaulting to `$HOME`. This mirrors the Brain's
 * `startDir()` so the voice-dispatched agents land in the same place the Brain
 * roams. (We do NOT invent a project picker.)
 *
 * `home` is injectable for tests.
 */
export function resolveTargetRepo(home: string): string {
  const hint = process.env.DIRECTOR_PROJECT_ROOT;
  return hint && hint.length > 0 ? hint : home;
}
