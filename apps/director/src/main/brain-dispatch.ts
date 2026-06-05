/**
 * Brain dispatch — the executor behind the brain's `dispatch_agent` tool
 * (finish-spec §B.2).
 *
 * The deep brain (agent-brain.ts) runs in the MAIN process and drives a
 * persistent roaming shell. This module lets the brain dispatch a REAL Codex
 * coding sub-agent INTO whatever directory its shell is currently in — so the
 * flow "mkdir a folder, git init it, then spin up the team there" is one thing
 * the brain controls end to end.
 *
 * Both dispatch entry points share ONE driver — the codex-pool
 * `dispatchAgent` → `dispatchAgentCore`:
 *   - the brain's `dispatch_agent`        → dispatchFromBrain (here)
 *   - the realtime `dispatch_agent_mock`  → tool-router handleDispatchAgentMock
 * The realtime path goes through `agent-tools.dispatchAgentReal` (a thin
 * validation+mapping wrapper) before `dispatchAgent`; the brain calls
 * `dispatchAgent` directly with the same request shape, applying the same
 * task/session guards inline. We call the wrapper-free entry because the brain
 * needs to set `useWorktree` on the request, and threading that field through
 * `dispatchAgentReal`'s public signature is INTEGRATE-wave wiring (see
 * wiring_required) — bypassing it keeps this FIX-wave file self-contained
 * while still hitting the identical pool driver. The only difference between
 * the two entry points is who supplies `targetRepo` (the brain's cwd) and
 * whether worktree mode + a `batchId` are set.
 *
 * Electron isolation: `codex-pool` imports `electron`, and `agent-brain`
 * deliberately stays headless-importable (planner.test.ts pulls it in). So
 * everything Electron-touching is `await import(...)`ed lazily inside the
 * executor — the same trick `show_canvas` uses for `canvas.js`. This module
 * therefore has NO top-level Electron/agent-brain import; the cycle
 * agent-brain → brain-dispatch → agent-brain is broken by the lazy imports.
 */

import type { AgentRole } from '../shared/state.js';

// ─── Identity table ─────────────────────────────────────────────────────
// The brain picks an agent by role-slug; we resolve the canonical name + role
// from the SAME maya/jin/cleo/wren mapping the realtime tool-router uses. This
// is a deliberate tiny local copy (not a shared import) so brain-dispatch
// stays decoupled from the router; if a single shared identity table is later
// wanted, that's an INTEGRATE-wave call (see wiring_required).

type BrainAgentSlug = 'maya' | 'jin' | 'cleo' | 'wren';

interface BrainAgentIdentity {
  id: BrainAgentSlug;
  name: string;
  role: AgentRole;
}

const BRAIN_IDENTITY: Record<BrainAgentSlug, BrainAgentIdentity> = {
  maya: { id: 'maya', name: 'Maya', role: 'Frontend' },
  jin: { id: 'jin', name: 'Jin', role: 'Backend' },
  cleo: { id: 'cleo', name: 'Cleo', role: 'Data' },
  wren: { id: 'wren', name: 'Wren', role: 'Design' },
};

export interface DispatchFromBrainArgs {
  agent: BrainAgentSlug;
  task: string;
  /** Default false = shared cwd; true = isolated worktree that auto-merges. */
  useWorktree?: boolean;
}

export type DispatchFromBrainResult =
  | {
      ok: true;
      agent_id: string;
      branch: string;
      /** The working directory the agent runs in (worktree path or the cwd). */
      worktree: string;
      mode: 'shared' | 'worktree';
    }
  | { ok: false; error: string };

/**
 * Resolve where the dispatch targets: the brain's live roaming-shell cwd. If
 * the brain hasn't been pointed anywhere yet, `getBrainCwd()` returns its
 * start dir (process cwd / DIRECTOR_PROJECT_ROOT / $HOME). `ensureDispatchTarget`
 * (called inside the pool) git-inits it if it isn't a repo, so a brand-new
 * folder the brain just `mkdir`'d Just Works.
 *
 * Lazy-imported so the agent-brain ↔ brain-dispatch cycle never resolves
 * eagerly and the headless test path doesn't pull the full brain graph.
 */
async function resolveBrainTarget(): Promise<string> {
  const { getBrainCwd } = await import('./agent-brain.js');
  return getBrainCwd();
}

/**
 * Dispatch a real Codex sub-agent into the brain's current working directory.
 * Returns immediately with the agent id + branch + mode (the pool's streaming
 * loop runs detached and emits `codex.event`s that light up the Hive).
 *
 * The driver chain is the SAME one the realtime path uses, so there is exactly
 * one dispatch implementation. `targetRepo` comes from the brain's cwd; in
 * worktree mode we set a `batchId` so the existing `batch_completed` →
 * `mergeFanIn` auto-merge fan-in fires (it only synthesizes for batched
 * worktree agents — finish-spec §B.4).
 */
export async function dispatchFromBrain(
  args: DispatchFromBrainArgs,
): Promise<DispatchFromBrainResult> {
  const identity = BRAIN_IDENTITY[args.agent];
  if (!identity) {
    return { ok: false, error: `unknown agent "${String(args.agent)}"` };
  }
  if (!args.task || typeof args.task !== 'string') {
    return { ok: false, error: 'missing task brief' };
  }

  const useWorktree = args.useWorktree ?? false;
  const targetRepo = await resolveBrainTarget();
  if (!targetRepo) {
    return { ok: false, error: 'could not resolve a working directory' };
  }

  // Lazy Electron-side imports (codex-pool pulls in electron). The headless
  // test path stubs these via the injectable driver below.
  const { dispatchAgent } = await import('./codex-pool.js');
  const { getSessionId } = await import('./side-store.js');

  // The fan-in auto-merge is driven by a synthetic `batch_completed` event,
  // which only fires for batched agents. So worktree-mode dispatches MUST
  // carry a batchId (even a single-agent batch) — finish-spec §B.4.
  const sessionId = getSessionId() ?? `brain-${Date.now()}`;
  const batchId = useWorktree
    ? `brain-${sessionId}-${Date.now()}`
    : undefined;

  const ack = await dispatchAgent(
    {
      agentId: identity.id,
      name: identity.name,
      role: identity.role,
      task: args.task,
      targetRepo,
      useWorktree,
      ...(batchId ? { batchId } : {}),
    },
    sessionId,
  );

  if (!ack.ok) {
    return { ok: false, error: ack.error };
  }
  return {
    ok: true,
    agent_id: ack.agentId,
    branch: ack.branch,
    worktree: ack.worktree,
    mode: useWorktree ? 'worktree' : 'shared',
  };
}

/** Test/diagnostic hook — exposes the identity table for unit assertions. */
export const _internals = { BRAIN_IDENTITY };
