/**
 * Director — canonical renderer state store.
 *
 * Single source of truth per docs/state-machine.md. Actions enforce the
 * transition rules described in §7 of the spec. The view-model store that
 * used to live alongside this was removed once W2's components migrated to
 * this store; the strip + Hive UI binds directly to `useStore` (or the
 * memoized hooks in `selectors.ts`).
 */

import { create } from 'zustand';
import type {
  Agent as CanonicalAgent,
  AgentId,
  CanvasComponentName,
  CanvasComponentProps,
  CanvasState as CanonicalCanvasState,
  HarnessRule,
  RealtimeStatus,
  SerializableStore,
  StripState as CanonicalStripState,
  TranscriptItem,
} from '../../../shared/state.js';

// ─── Tunables ─────────────────────────────────────────────────────────────

const TASK_TRAIL_CAP = 8;
const RECENT_FILES_CAP = 3;
const TRANSCRIPT_CAP = 200;
const THINKING_TRAIL_CAP = 6;
const CANVAS_DISMISS_MS = 400;

const isDev =
  typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

function warnIllegal(action: string, kind: CanonicalStripState['kind']): void {
  if (isDev) {
    // eslint-disable-next-line no-console
    console.warn(`[state] illegal transition: ${action} from strip.kind="${kind}"`);
  }
}

function pushRing<T>(arr: T[], item: T, cap: number): T[] {
  const next = [...arr, item];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

function clearCanvasTimer(canvas: CanonicalCanvasState): void {
  if (canvas.dismissTimerId != null && typeof window !== 'undefined') {
    window.clearTimeout(canvas.dismissTimerId);
  }
}

// ─── Slices ───────────────────────────────────────────────────────────────

export interface RealtimeSlice {
  status: RealtimeStatus;
  sessionId: string | null;
  micMuted: boolean;
  rotationDueAt: number | null;
}

export interface SetRealtimeMeta {
  sessionId?: string | null;
  rotationDueAt?: number | null;
}

export interface OpenCanvasArgs {
  componentId: string;
  component: CanvasComponentName;
  props: CanvasComponentProps;
  interactive: boolean;
}

export interface Store {
  strip: CanonicalStripState;
  realtime: RealtimeSlice;
  agents: Record<AgentId, CanonicalAgent>;
  agentOrder: AgentId[];
  canvas: CanonicalCanvasState;
  harness: HarnessRule[];
  transcript: TranscriptItem[];
  goal: string | null;

  summon: (mode: 'tap' | 'hold') => void;
  mute: () => void;
  setListening: (mode: 'tap' | 'hold') => void;
  setSpeaking: (itemId: string, phase: 'commentary' | 'final_answer') => void;
  setThinking: () => void;
  appendThinkingTrail: (line: string) => void;
  enterHive: (activeAgentId?: AgentId | null) => void;
  exitHive: () => void;

  setGoal: (goal: string | null) => void;
  addAgent: (agent: CanonicalAgent) => void;
  updateAgent: (id: AgentId, patch: Partial<CanonicalAgent>) => void;
  blockAgent: (id: AgentId, blocker: string) => void;
  resolveAgent: (id: AgentId, resumeTask?: string) => void;
  completeAgent: (id: AgentId, summary?: string) => void;
  failAgent: (id: AgentId, error: string) => void;
  clearAgents: () => void;

  openCanvas: (args: OpenCanvasArgs) => void;
  dismissCanvas: (componentId?: string) => void;
  submitCanvasResponse: (componentId: string, value: unknown) => void;

  addHarnessRule: (rule: HarnessRule) => void;
  appendTranscript: (item: TranscriptItem) => void;

  setRealtimeStatus: (status: RealtimeStatus, meta?: SetRealtimeMeta) => void;
  setError: (code: string, message: string, recoverable: boolean) => void;
  recoverFromError: () => void;
  setDisconnected: (reason: 'network' | 'auth' | 'rotation-failed') => void;
  reconnect: () => void;

  snapshot: () => SerializableStore;
}

const initialCanvas: CanonicalCanvasState = {
  open: false,
  phase: 'hidden',
  componentId: null,
  component: null,
  props: null,
  interactive: false,
  dismissTimerId: null,
  openedAt: null,
  queue: [],
};

const initialRealtime: RealtimeSlice = {
  status: 'idle',
  sessionId: null,
  micMuted: false,
  rotationDueAt: null,
};

const initialStrip: CanonicalStripState = { kind: 'dormant' };

export const useStore = create<Store>((set, get) => ({
  strip: initialStrip,
  realtime: initialRealtime,
  agents: {},
  agentOrder: [],
  canvas: initialCanvas,
  harness: [],
  transcript: [],
  goal: null,

  summon: (mode) => {
    const { strip, realtime } = get();
    const allowed: CanonicalStripState['kind'][] = [
      'dormant',
      'hive',
      'error',
      'disconnected',
    ];
    if (!allowed.includes(strip.kind)) {
      warnIllegal('summon', strip.kind);
      return;
    }
    if (strip.kind === 'disconnected') {
      set({
        strip: { kind: 'connecting', attempt: 1, since: Date.now() },
        realtime: { ...realtime, status: 'connecting' },
      });
      return;
    }
    set({
      strip: { kind: 'listening', mode, since: Date.now() },
      realtime: { ...realtime, micMuted: false },
    });
  },

  mute: () => {
    const { strip, realtime } = get();
    set({ realtime: { ...realtime, micMuted: true } });
    if (strip.kind === 'listening') {
      const hasWork = Object.values(get().agents).some(
        (a) =>
          a.status === 'working' ||
          a.status === 'thinking' ||
          a.status === 'blocked',
      );
      set({
        strip: hasWork
          ? { kind: 'hive', activeAgentId: null, since: Date.now() }
          : { kind: 'dormant' },
      });
    }
  },

  setListening: (mode) => {
    const { strip, realtime } = get();
    const allowed: CanonicalStripState['kind'][] = [
      'dormant',
      'speaking',
      'hive',
      'thinking',
      'listening',
    ];
    if (!allowed.includes(strip.kind)) {
      warnIllegal('setListening', strip.kind);
      return;
    }
    set({
      strip: { kind: 'listening', mode, since: Date.now() },
      realtime: { ...realtime, micMuted: false },
    });
  },

  setSpeaking: (itemId, phase) => {
    const { strip } = get();
    const allowed: CanonicalStripState['kind'][] = [
      'listening',
      'thinking',
      'hive',
      'dormant',
    ];
    if (!allowed.includes(strip.kind)) {
      warnIllegal('setSpeaking', strip.kind);
      return;
    }
    set({ strip: { kind: 'speaking', itemId, phase, since: Date.now() } });
  },

  setThinking: () => {
    const { strip } = get();
    const allowed: CanonicalStripState['kind'][] = [
      'listening',
      'speaking',
      'hive',
    ];
    if (!allowed.includes(strip.kind)) {
      warnIllegal('setThinking', strip.kind);
      return;
    }
    set({ strip: { kind: 'thinking', trail: [], since: Date.now() } });
  },

  appendThinkingTrail: (line) => {
    const { strip } = get();
    if (strip.kind !== 'thinking') return;
    set({
      strip: {
        ...strip,
        trail: pushRing(strip.trail, line, THINKING_TRAIL_CAP),
      },
    });
  },

  enterHive: (activeAgentId = null) => {
    const { strip } = get();
    const allowed: CanonicalStripState['kind'][] = [
      'dormant',
      'listening',
      'speaking',
      'thinking',
      'hive',
    ];
    if (!allowed.includes(strip.kind)) {
      warnIllegal('enterHive', strip.kind);
      return;
    }
    set({ strip: { kind: 'hive', activeAgentId, since: Date.now() } });
  },

  exitHive: () => {
    const { strip } = get();
    if (strip.kind !== 'hive') return;
    set({ strip: { kind: 'dormant' } });
  },

  setGoal: (goal) => set({ goal }),

  addAgent: (agent) => {
    const { agents, agentOrder, strip } = get();
    if (agents[agent.id]) {
      get().updateAgent(agent.id, agent);
      return;
    }
    set({
      agents: { ...agents, [agent.id]: agent },
      agentOrder: [...agentOrder, agent.id],
    });
    if (strip.kind === 'dormant') {
      set({ strip: { kind: 'hive', activeAgentId: agent.id, since: Date.now() } });
    }
  },

  updateAgent: (id, patch) => {
    const { agents } = get();
    const existing = agents[id];
    if (!existing) return;
    let taskTrail = existing.taskTrail;
    let recentFiles = existing.recentFiles;
    if (patch.currentTask && patch.currentTask !== existing.currentTask) {
      taskTrail = pushRing(taskTrail, patch.currentTask, TASK_TRAIL_CAP);
    }
    if (patch.recentFiles) {
      recentFiles = patch.recentFiles.slice(-RECENT_FILES_CAP);
    }
    const next: CanonicalAgent = {
      ...existing,
      ...patch,
      taskTrail,
      recentFiles,
    };
    set({ agents: { ...agents, [id]: next } });
  },

  blockAgent: (id, blocker) => {
    const { agents } = get();
    const a = agents[id];
    if (!a) return;
    const next: CanonicalAgent = { ...a, status: 'blocked', blocker };
    set({
      agents: { ...agents, [id]: next },
      strip: {
        kind: 'escalating',
        agentId: id,
        blocker,
        since: Date.now(),
      },
    });
  },

  resolveAgent: (id, resumeTask) => {
    const { agents } = get();
    const a = agents[id];
    if (!a) return;
    const next: CanonicalAgent = {
      ...a,
      status: 'working',
      blocker: null,
      currentTask: resumeTask ?? a.currentTask,
      taskTrail: resumeTask
        ? pushRing(a.taskTrail, resumeTask, TASK_TRAIL_CAP)
        : a.taskTrail,
    };
    const nextAgents = { ...agents, [id]: next };
    const stillBlocked = Object.values(nextAgents).some(
      (x) => x.status === 'blocked' || x.status === 'error',
    );
    set({
      agents: nextAgents,
      strip: stillBlocked
        ? get().strip
        : { kind: 'hive', activeAgentId: id, since: Date.now() },
    });
  },

  completeAgent: (id, summary) => {
    const { agents } = get();
    const a = agents[id];
    if (!a) return;
    const next: CanonicalAgent = {
      ...a,
      status: 'done',
      finishedAt: Date.now(),
      currentTask: summary ?? a.currentTask,
    };
    const nextAgents = { ...agents, [id]: next };
    set({ agents: nextAgents });
    const allDone = Object.values(nextAgents).every(
      (x) => x.status === 'done' || x.status === 'killed',
    );
    if (allDone) {
      const kind = get().strip.kind;
      if (kind === 'hive' || kind === 'escalating') {
        set({ strip: { kind: 'dormant' } });
      }
    }
  },

  failAgent: (id, error) => {
    const { agents } = get();
    const a = agents[id];
    if (!a) return;
    const next: CanonicalAgent = { ...a, status: 'error', blocker: error };
    set({
      agents: { ...agents, [id]: next },
      strip: {
        kind: 'escalating',
        agentId: id,
        blocker: error,
        since: Date.now(),
      },
    });
  },

  clearAgents: () => set({ agents: {}, agentOrder: [] }),

  openCanvas: (args) => {
    const { canvas } = get();
    if (canvas.open) {
      set({ canvas: { ...canvas, queue: [...canvas.queue, args] } });
      return;
    }
    clearCanvasTimer(canvas);
    set({
      canvas: {
        open: true,
        phase: 'opening',
        componentId: args.componentId,
        component: args.component,
        props: args.props,
        interactive: args.interactive,
        dismissTimerId: null,
        openedAt: Date.now(),
        queue: [],
      },
    });
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        const c = get().canvas;
        if (c.componentId === args.componentId && c.phase === 'opening') {
          set({
            canvas: {
              ...c,
              phase: args.interactive ? 'awaiting-response' : 'open',
            },
          });
        }
      }, 240);
    }
  },

  dismissCanvas: (componentId) => {
    const { canvas } = get();
    if (!canvas.open) return;
    if (componentId && canvas.componentId !== componentId) return;
    clearCanvasTimer(canvas);
    const [nextItem, ...rest] = canvas.queue;
    if (nextItem) {
      set({
        canvas: {
          open: true,
          phase: 'opening',
          componentId: nextItem.componentId,
          component: nextItem.component,
          props: nextItem.props,
          interactive: nextItem.interactive,
          dismissTimerId: null,
          openedAt: Date.now(),
          queue: rest,
        },
      });
      return;
    }
    set({ canvas: { ...initialCanvas, phase: 'dismissing' } });
    if (typeof window !== 'undefined') {
      window.setTimeout(() => set({ canvas: initialCanvas }), 200);
    }
  },

  submitCanvasResponse: (componentId, _value) => {
    void _value;
    const { canvas } = get();
    if (!canvas.open || canvas.componentId !== componentId) return;
    clearCanvasTimer(canvas);
    let timerId: number | null = null;
    if (typeof window !== 'undefined') {
      timerId = window.setTimeout(() => {
        get().dismissCanvas(componentId);
      }, CANVAS_DISMISS_MS) as unknown as number;
    }
    set({
      canvas: {
        ...canvas,
        phase: 'open',
        dismissTimerId: timerId,
      },
    });
  },

  addHarnessRule: (rule) => {
    const { harness } = get();
    set({ harness: [rule, ...harness] });
    get().openCanvas({
      componentId: `harness-flash-${rule.id}`,
      component: 'harness_flash',
      props: { rule: rule.rule, why: rule.why },
      interactive: false,
    });
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        get().dismissCanvas(`harness-flash-${rule.id}`);
      }, 1200);
    }
  },

  appendTranscript: (item) => {
    const { transcript } = get();
    const next = [...transcript, item];
    set({
      transcript:
        next.length > TRANSCRIPT_CAP
          ? next.slice(next.length - TRANSCRIPT_CAP)
          : next,
    });
  },

  setRealtimeStatus: (status, meta) => {
    const { realtime, strip } = get();
    const nextRealtime: RealtimeSlice = {
      ...realtime,
      status,
      sessionId:
        meta?.sessionId !== undefined ? meta.sessionId : realtime.sessionId,
      rotationDueAt:
        meta?.rotationDueAt !== undefined
          ? meta.rotationDueAt
          : realtime.rotationDueAt,
    };
    set({ realtime: nextRealtime });
    if (status === 'connecting' && strip.kind === 'dormant') {
      set({ strip: { kind: 'connecting', attempt: 1, since: Date.now() } });
    } else if (status === 'degraded' && strip.kind !== 'disconnected') {
      set({
        strip: { kind: 'disconnected', reason: 'network', since: Date.now() },
      });
    } else if (status === 'live' && strip.kind === 'connecting') {
      set({ strip: { kind: 'dormant' } });
    }
  },

  setError: (code, message, recoverable) => {
    set({
      strip: { kind: 'error', code, message, recoverable, since: Date.now() },
    });
  },

  recoverFromError: () => {
    const { strip } = get();
    if (strip.kind !== 'error' || !strip.recoverable) {
      warnIllegal('recoverFromError', strip.kind);
      return;
    }
    set({ strip: { kind: 'dormant' } });
  },

  setDisconnected: (reason) => {
    const { realtime } = get();
    set({
      strip: { kind: 'disconnected', reason, since: Date.now() },
      realtime: { ...realtime, status: 'degraded' },
    });
  },

  reconnect: () => {
    const { strip, realtime } = get();
    if (strip.kind !== 'disconnected') {
      warnIllegal('reconnect', strip.kind);
      return;
    }
    set({
      strip: { kind: 'connecting', attempt: 1, since: Date.now() },
      realtime: { ...realtime, status: 'connecting' },
    });
  },

  snapshot: (): SerializableStore => {
    const s = get();
    const { dismissTimerId: _drop, ...canvasNoTimer } = s.canvas;
    void _drop;
    return {
      strip: s.strip,
      realtime: { ...s.realtime },
      agents: { ...s.agents },
      agentOrder: [...s.agentOrder],
      canvas: canvasNoTimer,
      harness: [...s.harness],
      transcript: [...s.transcript],
      goal: s.goal,
    };
  },
}));

// ─── Sugar for non-React callers (sim, IPC handlers) ─────────────────────

export function getStore(): Store {
  return useStore.getState();
}

export const commands = {
  summon: (mode: 'tap' | 'hold') => getStore().summon(mode),
  mute: () => getStore().mute(),
  setListening: (mode: 'tap' | 'hold') => getStore().setListening(mode),
  setSpeaking: (id: string, phase: 'commentary' | 'final_answer') =>
    getStore().setSpeaking(id, phase),
  setThinking: () => getStore().setThinking(),
  appendThinkingTrail: (line: string) => getStore().appendThinkingTrail(line),
  enterHive: (id?: AgentId | null) => getStore().enterHive(id ?? null),
  exitHive: () => getStore().exitHive(),
  setGoal: (goal: string | null) => getStore().setGoal(goal),
  addAgent: (a: CanonicalAgent) => getStore().addAgent(a),
  updateAgent: (id: AgentId, patch: Partial<CanonicalAgent>) =>
    getStore().updateAgent(id, patch),
  blockAgent: (id: AgentId, blocker: string) =>
    getStore().blockAgent(id, blocker),
  resolveAgent: (id: AgentId, resumeTask?: string) =>
    getStore().resolveAgent(id, resumeTask),
  completeAgent: (id: AgentId, summary?: string) =>
    getStore().completeAgent(id, summary),
  failAgent: (id: AgentId, error: string) => getStore().failAgent(id, error),
  addHarnessRule: (rule: HarnessRule) => getStore().addHarnessRule(rule),
  appendTranscript: (item: TranscriptItem) =>
    getStore().appendTranscript(item),
  openCanvas: (args: OpenCanvasArgs) => getStore().openCanvas(args),
  dismissCanvas: (id?: string) => getStore().dismissCanvas(id),
  submitCanvasResponse: (id: string, value: unknown) =>
    getStore().submitCanvasResponse(id, value),
  setRealtimeStatus: (status: RealtimeStatus, meta?: SetRealtimeMeta) =>
    getStore().setRealtimeStatus(status, meta),
};

export type Commands = typeof commands;

// Re-export canonical types so callers only need this import.
export type {
  CanonicalAgent,
  AgentId,
  CanonicalCanvasState,
  CanonicalStripState,
  HarnessRule,
  RealtimeStatus,
  TranscriptItem,
};
