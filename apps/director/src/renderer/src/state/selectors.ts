/**
 * Memoized selector hooks over the canonical state store.
 *
 * Spec: docs/state-machine.md §9. Components should prefer these over
 * inline `useStore((s) => ...)` selectors so re-render fan-out stays
 * predictable. Each hook subscribes to the narrowest slice it can.
 */

import { useStore } from './store.js';
import type {
  Agent,
  AgentId,
  AgentStatus,
  CanvasState,
  HarnessRule,
  RealtimeStatus,
  StripState,
  StripStateKind,
  TranscriptItem,
} from '../../../shared/state.js';

// ─── Strip ────────────────────────────────────────────────────────────────

export function useStrip(): StripState {
  return useStore((s) => s.strip);
}

export function useStripKind(): StripStateKind {
  return useStore((s) => s.strip.kind);
}

// ─── Agents ───────────────────────────────────────────────────────────────

export function useAgents(): Agent[] {
  return useStore((s) => s.agentOrder.map((id) => s.agents[id]!).filter(Boolean));
}

export function useAgent(id: AgentId): Agent | undefined {
  return useStore((s) => s.agents[id]);
}

export function useAgentsByStatus(status: AgentStatus): Agent[] {
  return useStore((s) =>
    s.agentOrder
      .map((id) => s.agents[id])
      .filter((a): a is Agent => Boolean(a) && a!.status === status),
  );
}

const HIVE_RANK: Record<AgentStatus, number> = {
  blocked: 0,
  working: 1,
  thinking: 2,
  spawning: 3,
  done: 4,
  error: 5,
  killed: 6,
};

/**
 * Hive-ordered agents: blocked → working → thinking → spawning → done →
 * error → killed; within each group, oldest `dispatchedAt` first.
 * Matches Pass 1 §Hive.
 */
export function useAgentsOrderedForHive(): Agent[] {
  return useStore((s) => {
    const list = s.agentOrder.map((id) => s.agents[id]).filter((a): a is Agent => Boolean(a));
    return [...list].sort((a, b) => {
      const r = HIVE_RANK[a.status] - HIVE_RANK[b.status];
      if (r !== 0) return r;
      return a.dispatchedAt - b.dispatchedAt;
    });
  });
}

// ─── Canvas ───────────────────────────────────────────────────────────────

export function useCanvas(): CanvasState {
  return useStore((s) => s.canvas);
}

export function useIsCanvasOpen(): boolean {
  return useStore((s) => s.canvas.open);
}

// ─── Harness ──────────────────────────────────────────────────────────────

export function useHarnessRules(): HarnessRule[] {
  return useStore((s) => s.harness);
}

// ─── Transcript ───────────────────────────────────────────────────────────

export function useRecentTranscript(n: number): TranscriptItem[] {
  return useStore((s) =>
    n >= s.transcript.length ? s.transcript : s.transcript.slice(-n),
  );
}

// ─── Realtime ─────────────────────────────────────────────────────────────

export function useRealtimeStatus(): RealtimeStatus {
  return useStore((s) => s.realtime.status);
}

// ─── Derived predicates ──────────────────────────────────────────────────

export function useIsAnyAgentBlocked(): boolean {
  return useStore((s) =>
    Object.values(s.agents).some((a) => a.status === 'blocked' || a.status === 'error'),
  );
}

export function useCurrentBlocker(): { agent: Agent; blocker: string } | null {
  return useStore((s) => {
    const blocked = Object.values(s.agents)
      .filter((a): a is Agent => a.status === 'blocked' || a.status === 'error')
      .sort((a, b) => a.dispatchedAt - b.dispatchedAt);
    if (blocked.length === 0) return null;
    const top = blocked[0]!;
    return { agent: top, blocker: top.blocker ?? 'unknown' };
  });
}

export function useGoal(): string | null {
  return useStore((s) => s.goal);
}

export function useCanSummon(): boolean {
  return useStore((s) => s.realtime.status === 'live' && s.strip.kind !== 'error');
}

export function useHasActiveWork(): boolean {
  return useStore((s) =>
    Object.values(s.agents).some(
      (a) =>
        a.status === 'working' ||
        a.status === 'thinking' ||
        a.status === 'spawning' ||
        a.status === 'blocked',
    ),
  );
}
