/**
 * Agent registry — main-side read model of the currently-running sub-agents.
 *
 * Backs the `list_agents` Realtime tool (docs/voice-genui-spec.md §3.1): the
 * voice layer answers "what's running?" / "what's happening?" instantly from
 * state, WITHOUT consulting the deep brain.
 *
 * Data source (spec §3.1, option (a) — CHOSEN): the main-side **side-store
 * world view** (`side-store.readWorldState()`), the same source the planner
 * already reads (`planner.ts` imports it as `readSideStoreWorldState`). The
 * canonical agent state lives in the renderer Zustand store, which the main
 * process does NOT mirror; but `tool-router`'s dispatch + kill/extend handlers
 * persist agent snapshots to the side-store (`queueAgentWrite` →
 * `agents/<id>.json`), so `readWorldState().active_agents` is the populated,
 * main-local, synchronous-ish (fast disk read) source we map here.
 *
 * Until real dispatch is on (§3.3) the side-store is populated by
 * `dispatch_agent_mock` + the kill/extend handlers, so this reflects the
 * mock/sim agents — the correct demo behavior.
 *
 * This module is pure mapping over an injectable reader, so it unit-tests
 * headlessly (inject a fake world view; no disk, no Electron).
 */

import type { Agent, AgentStatus } from '../shared/state.js';
import { readWorldState, type WorldState } from './side-store.js';

/**
 * The per-agent shape `list_agents` surfaces to the voice layer. A superset
 * of the spec's wire shape (§3.1 returns `{ name, role, status, currentTask }`)
 * — we also carry `id` + `recentFiles` so the same view can feed richer
 * consumers (e.g. an `agent_pod` fallback) without a second read. The
 * `handleListAgents` wire mapper narrows to the spec's four fields.
 */
export interface ActiveAgentView {
  id: string;
  name: string;
  role: string;
  status: AgentStatus | string;
  currentTask: string | null;
  recentFiles: string[];
}

/**
 * The narrow wire shape the `list_agents` tool returns to the model
 * (docs/voice-genui-spec.md §3.1). Kept terse — the voice layer reads it
 * aloud, so we don't pump `id`/`recentFiles` across the tool boundary.
 */
export interface ListAgentsItem {
  name: string;
  role: string;
  status: string;
  currentTask: string | null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Map one side-store `Agent` to the registry view. Defensive: tolerates
 * partial / malformed agent rows (a torn JSON file, a future schema field)
 * by coercing to safe defaults rather than throwing — `list_agents` must
 * never make the voice turn fail.
 */
export function toActiveAgentView(agent: Partial<Agent> & { id?: unknown }): ActiveAgentView {
  const id = asString(agent?.id) ?? 'unknown';
  return {
    id,
    name: asString(agent?.name) ?? id,
    role: asString(agent?.role) ?? 'Frontend',
    status: asString(agent?.status as string) ?? 'working',
    currentTask: asString(agent?.currentTask) ?? null,
    recentFiles: Array.isArray(agent?.recentFiles)
      ? agent!.recentFiles!.filter((f): f is string => typeof f === 'string').slice(0, 3)
      : [],
  };
}

/**
 * Pure core — map a materialized world view to the active-agent list. Exposed
 * so a unit test can drive it with a fabricated `WorldState` and so callers
 * that already hold a world view don't re-read disk.
 *
 * Filters out terminal agents (`done` / `error` / `killed`) so "what's
 * running?" reflects what's *live* — finished agents stay on the Hive but are
 * not "running". (Callers wanting the full roster can read `active_agents`
 * directly.)
 */
export function selectActiveAgents(world: Pick<WorldState, 'active_agents'>): ActiveAgentView[] {
  const agents = Array.isArray(world?.active_agents) ? world.active_agents : [];
  const TERMINAL = new Set<string>(['done', 'error', 'killed']);
  return agents
    .map(toActiveAgentView)
    .filter((a) => !TERMINAL.has(String(a.status)));
}

/**
 * Read the live side-store world view and return the active sub-agents.
 *
 * `readWorldState()` auto-initializes the session, so callers don't need to
 * remember the lifecycle. Returns `[]` on any read failure (the voice layer
 * gets "nothing running" rather than an error).
 */
export async function listActiveAgents(): Promise<ActiveAgentView[]> {
  try {
    const world = await readWorldState();
    return selectActiveAgents(world);
  } catch (err) {
    console.warn('[agent-registry] listActiveAgents read failed', err);
    return [];
  }
}

/** Narrow a registry view to the `list_agents` wire item (spec §3.1). */
export function toListAgentsItem(view: ActiveAgentView): ListAgentsItem {
  return {
    name: view.name,
    role: view.role,
    status: String(view.status),
    currentTask: view.currentTask,
  };
}
