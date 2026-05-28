/**
 * Mixtape demo simulator.
 *
 * Drives the "happy path" demo: dispatches the four named agents, runs
 * trail updates on a timer, blocks Jin at the spec moment, waits for the
 * user (or the orchestration layer) to resolve, then completes everyone in
 * the canonical order. Purely timer-driven — no Realtime / Codex / IPC.
 *
 * Two timelines:
 *   - `compressed: true`  (default for dev key D)      — full demo in ~60s.
 *   - `compressed: false` (canonical, docs/demo-timeline.md) — Jin blocks
 *     50s after the first dispatch; completions land at 140s/155s/175s/195s.
 *     All times relative to startMixtapeDemo() — i.e. they assume the first
 *     `dispatch_agent_mock` call (real T+0:55 in the demo doc) is the
 *     trigger.
 *
 * When Jin blocks, a `director:escalation` CustomEvent fires on `window` so
 * any layer (App.tsx debug log, future Realtime injector) can react. See
 * docs/ipc-contracts.md §10 for the event contract.
 */

import { commands, getStore, useStore } from './store.js';
import type { Agent as CanonicalAgent, HarnessRule } from '../../../shared/state.js';

// ─── Identity tokens — Pass 4 anti-slop ──────────────────────────────────

const ACCENT_HEX = {
  maya: '#E07856',
  jin: '#4A9E9C',
  cleo: '#C99550',
  wren: '#9670A0',
} as const satisfies Record<string, `#${string}`>;

// ─── Timeline shape ──────────────────────────────────────────────────────

export interface MixtapeTimeline {
  /** Initial seed dispatch — agents land as `working`. */
  dispatchAt: number;
  /** First trail-update batch (T+1:15 in demo-timeline.md). */
  firstTrailBatchAt: number;
  /** Second trail-update batch (T+1:30). */
  secondTrailBatchAt: number;
  /** Jin transitions to blocked — fires the escalation event. */
  jinBlockAt: number;
  /** Absolute timeline marks for the four completions. */
  cleoDoneAt: number;
  wrenDoneAt: number;
  jinDoneAt: number;
  mayaDoneAt: number;
}

/**
 * Canonical timeline — mirrors docs/demo-timeline.md exactly, shifted by
 * −55s so the first dispatch is sim_T+0. (The doc treats T+0 as the user's
 * first utterance; dispatch happens at T+0:55.)
 */
const EXTENDED: MixtapeTimeline = {
  dispatchAt: 0,
  firstTrailBatchAt: 20_000, // 1:15 − 0:55
  secondTrailBatchAt: 35_000, // 1:30 − 0:55
  jinBlockAt: 50_000, // 1:45 − 0:55
  cleoDoneAt: 140_000, // 3:15 − 0:55
  wrenDoneAt: 155_000, // 3:30 − 0:55
  jinDoneAt: 175_000, // 3:50 − 0:55
  mayaDoneAt: 195_000, // 4:10 − 0:55
};

/**
 * Dev/hackathon-compressed timeline — fits inside ~60s for fast iteration.
 */
const COMPRESSED: MixtapeTimeline = {
  dispatchAt: 0,
  firstTrailBatchAt: 5_000,
  secondTrailBatchAt: 12_000,
  jinBlockAt: 20_000,
  cleoDoneAt: 40_000,
  wrenDoneAt: 45_000,
  jinDoneAt: 50_000,
  mayaDoneAt: 55_000,
};

// ─── Narrative copy ──────────────────────────────────────────────────────

interface AgentPlan {
  id: 'maya' | 'jin' | 'cleo' | 'wren';
  name: string;
  role: 'Frontend' | 'Backend' | 'Data' | 'Design';
  task: string;
  filesArr: string[];
  /** Trail messages cycled at each batch tick. */
  trail: string[];
  /** Final summary on completion. */
  done: string;
  doneFiles: string;
  doneFilesArr: string[];
}

const PLAN: AgentPlan[] = [
  {
    id: 'maya',
    name: 'Maya',
    role: 'Frontend',
    task: 'wiring the flip animation',
    filesArr: ['app/PlaylistCard.tsx', 'app/CoverArt.tsx'],
    trail: [
      'tuning the spring physics',
      'writing CoverArt SVG',
      'PlaylistCard ready to flip',
    ],
    done: 'PlaylistCard ready to flip',
    doneFiles: '4 files · 184 lines',
    doneFilesArr: ['app/PlaylistCard.tsx', 'app/CoverArt.tsx', 'app/flip.css'],
  },
  {
    id: 'jin',
    name: 'Jin',
    role: 'Backend',
    task: 'POST /api/generate routed',
    filesArr: ['lib/generator.ts'],
    trail: [
      'writing mock-track seed',
      'tying generator to seed list',
      'wiring response envelope',
    ],
    done: 'generate route + mock seed shipped',
    doneFiles: '2 files · 96 lines',
    doneFilesArr: ['app/api/generate/route.ts', 'lib/billing.ts'],
  },
  {
    id: 'cleo',
    name: 'Cleo',
    role: 'Data',
    task: 'Mixtape schema written',
    filesArr: ['lib/schema.ts'],
    trail: [
      'file-backed store going',
      'index on vibe field',
      'schema + store committed',
    ],
    done: 'schema + store committed',
    doneFiles: '3 files · 71 lines',
    doneFilesArr: ['lib/schema.ts', 'lib/db.ts', 'drizzle/0001.sql'],
  },
  {
    id: 'wren',
    name: 'Wren',
    role: 'Design',
    task: 'matte tokens locked',
    filesArr: ['tailwind.config.ts', 'app/themes.ts'],
    trail: [
      'cassette palette tuning',
      'micro-motion easing dialed',
      'cassette tokens shipped',
    ],
    done: 'cassette tokens shipped',
    doneFiles: '2 files · 48 lines',
    doneFilesArr: ['tailwind.config.ts', 'app/themes.ts'],
  },
];

const JIN_BLOCKER_TEXT = 'Stripe staging API key not in env';
const JIN_SUGGESTED_QUESTION =
  'Want me to wire real keys, or have Jin generate plausible mock tracks from a local seed list?';

// ─── Escalation event contract ───────────────────────────────────────────

/**
 * Payload for the `director:escalation` CustomEvent. The orchestration
 * layer listens on `window` and translates this into a server-initiated
 * Realtime utterance (per docs/research/gpt-realtime-2.md §8).
 */
export interface EscalationDetail {
  agent_id: string;
  blocker: string;
  suggested_question: string;
}

export const ESCALATION_EVENT = 'director:escalation';

function dispatchEscalation(detail: EscalationDetail): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent<EscalationDetail>(ESCALATION_EVENT, { detail }));
  } catch (err) {
    console.warn('[sim] failed to dispatch escalation event', err);
  }
}

// ─── Module state ────────────────────────────────────────────────────────

interface DemoHandle {
  timeline: MixtapeTimeline;
  timers: Array<ReturnType<typeof setTimeout>>;
  intervals: Array<ReturnType<typeof setInterval>>;
  startedAt: number;
  awaitingResolution: boolean;
  resolveExternal: (input: string) => void;
  stopped: boolean;
}

let active: DemoHandle | null = null;

// ─── Helpers ─────────────────────────────────────────────────────────────

function planToCanonical(p: AgentPlan, status: CanonicalAgent['status']): CanonicalAgent {
  const now = Date.now();
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    accentColor: ACCENT_HEX[p.id],
    status,
    currentTask: p.task,
    taskTrail: [p.task],
    recentFiles: p.filesArr.slice(-3),
    blocker: null,
    worktreePath: `~/.director/worktrees/${p.id}`,
    codexThreadId: null,
    dispatchedAt: now,
    finishedAt: null,
  };
}

function appendNarration(text: string, phase: 'commentary' | 'final_answer'): void {
  commands.appendTranscript({
    id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role: 'assistant',
    content: text,
    phase,
    timestamp: Date.now(),
  });
}

function schedule(handle: DemoHandle, fn: () => void, delayMs: number): void {
  if (handle.stopped) return;
  handle.timers.push(setTimeout(fn, delayMs));
}

function clearHandle(handle: DemoHandle): void {
  handle.stopped = true;
  handle.timers.forEach(clearTimeout);
  handle.intervals.forEach(clearInterval);
  handle.timers = [];
  handle.intervals = [];
}

// ─── Public API ──────────────────────────────────────────────────────────

export interface StartMixtapeDemoOptions {
  /**
   * `true` (default) — compressed ~60s timeline for dev iteration.
   * `false`          — canonical demo-timeline.md schedule (≈3:15 long).
   */
  compressed?: boolean;
  /** Goal pill displayed in the strip. */
  goal?: string;
  /** Pre-seed a harness rule. Pass `null` to skip. */
  seedHarness?: HarnessRule | null;
  /**
   * If `true` (default), startMixtapeDemo() seeds the 4 agents itself.
   * Set `false` when the tool-router is going to drive `dispatch_agent_mock`
   * calls — the sim then only runs the timer, and the router does the
   * agent additions.
   */
  seedAgents?: boolean;
  /** Optional handler invoked at the moment Jin blocks. */
  onBlocked?: (blocker: string, resolve: (input: string) => void) => void;
}

export function startMixtapeDemo(
  options: StartMixtapeDemoOptions = {},
): { stop: () => void; resolve: (input: string) => void } {
  if (active) {
    clearHandle(active);
    active = null;
  }

  const timeline = options.compressed === false ? EXTENDED : COMPRESSED;
  const goal = options.goal ?? 'Mixtape app';
  const seedAgents = options.seedAgents !== false;
  const seedHarness =
    options.seedHarness === undefined
      ? ({
          id: `rule-${Date.now()}`,
          rule: 'Cards use cassette material — translucent amber, vintage warmth',
          why: 'User picked cassette during card-material decision',
          timestamp: Date.now(),
          scope: 'project',
          source: 'user-utterance',
        } satisfies HarnessRule)
      : options.seedHarness;

  const handle: DemoHandle = {
    timeline,
    timers: [],
    intervals: [],
    startedAt: Date.now(),
    awaitingResolution: false,
    resolveExternal: () => {
      /* replaced when block fires */
    },
    stopped: false,
  };
  active = handle;

  // ── Reset store into a clean demo state ──────────────────────────────
  commands.setGoal(goal);
  useStore.setState({
    agents: {},
    agentOrder: [],
    strip: { kind: 'dormant' },
  });
  if (seedHarness) {
    commands.addHarnessRule(seedHarness);
  }

  // ── T+0: dispatch the four agents (or skip if router will drive) ────
  schedule(
    handle,
    () => {
      if (seedAgents) {
        for (const p of PLAN) {
          commands.addAgent(planToCanonical(p, 'working'));
        }
      }
      try {
        getStore().enterHive(PLAN[0]?.id ?? null);
      } catch {
        /* swallow */
      }
      appendNarration(
        'Dispatching Maya on the flip card, Jin on the API, Cleo on the schema, Wren on theme tokens.',
        'commentary',
      );
    },
    timeline.dispatchAt,
  );

  // ── T+1:15 (or +5s compressed): first trail batch ─────────────────────
  schedule(
    handle,
    () => runTrailBatch(0),
    timeline.firstTrailBatchAt,
  );

  // ── T+1:30 (or +12s compressed): second trail batch ───────────────────
  schedule(
    handle,
    () => runTrailBatch(1),
    timeline.secondTrailBatchAt,
  );

  // ── T+1:45 (or +20s compressed): Jin blocks → escalation ──────────────
  schedule(
    handle,
    () => {
      // Only block if Jin exists in the store. If the router never
      // dispatched Jin we silently skip — the demo just won't have
      // an escalation beat.
      const jin = useStore.getState().agents['jin'];
      if (!jin) return;
      commands.blockAgent('jin', JIN_BLOCKER_TEXT);
      appendNarration(`Jin's blocked — ${JIN_BLOCKER_TEXT}.`, 'commentary');

      handle.awaitingResolution = true;
      handle.resolveExternal = (input: string) =>
        resolveJinInternal(handle, input);
      options.onBlocked?.(JIN_BLOCKER_TEXT, handle.resolveExternal);

      dispatchEscalation({
        agent_id: 'jin',
        blocker: JIN_BLOCKER_TEXT,
        suggested_question: JIN_SUGGESTED_QUESTION,
      });
    },
    timeline.jinBlockAt,
  );

  // ── Completions on the canonical schedule ─────────────────────────────
  scheduleCompletion(handle, 'cleo', timeline.cleoDoneAt);
  scheduleCompletion(handle, 'wren', timeline.wrenDoneAt);
  scheduleCompletion(handle, 'jin', timeline.jinDoneAt);
  scheduleCompletion(handle, 'maya', timeline.mayaDoneAt);

  return {
    stop: () => {
      if (active === handle) active = null;
      clearHandle(handle);
    },
    resolve: (input: string) => {
      if (handle.awaitingResolution) handle.resolveExternal(input);
    },
  };
}

export function resolveJinBlocker(input: string): void {
  if (!active) return;
  if (!active.awaitingResolution) return;
  active.resolveExternal(input);
}

export function isAwaitingResolution(): boolean {
  return Boolean(active?.awaitingResolution);
}

export function stopMixtapeDemo(): void {
  if (!active) return;
  clearHandle(active);
  active = null;
}

/**
 * True iff the sim is currently driving the demo. Tool-router uses this to
 * detect whether to call `startMixtapeDemo({seedAgents: false})` on the
 * first `dispatch_agent_mock`.
 */
export function isDemoRunning(): boolean {
  return Boolean(active && !active.stopped);
}

// ─── Internals ───────────────────────────────────────────────────────────

function runTrailBatch(batchIndex: number): void {
  for (const p of PLAN) {
    const a = useStore.getState().agents[p.id];
    if (!a) continue;
    if (a.status === 'done' || a.status === 'killed' || a.status === 'blocked') {
      continue;
    }
    const message = p.trail[batchIndex % p.trail.length];
    if (!message) continue;
    commands.updateAgent(p.id, { currentTask: message });
  }
}

function scheduleCompletion(
  handle: DemoHandle,
  id: AgentPlan['id'],
  atMs: number,
): void {
  schedule(handle, () => completeIfReady(id), atMs);
}

function completeIfReady(id: AgentPlan['id']): void {
  const agent = useStore.getState().agents[id];
  if (!agent) return;
  if (agent.status === 'done' || agent.status === 'killed') return;
  // Jin only completes when he's been resolved off the block.
  if (agent.status === 'blocked' || agent.status === 'error') return;

  const plan = PLAN.find((p) => p.id === id);
  if (!plan) return;

  commands.completeAgent(id, plan.done);
  commands.updateAgent(id, { recentFiles: plan.doneFilesArr.slice(-3) });
  appendNarration(`${plan.name}: ${plan.done}.`, 'commentary');

  // After the last completion, let the hive hold for two beats then dorm.
  const everyoneDone = Object.values(useStore.getState().agents).every(
    (a) => a.status === 'done' || a.status === 'killed',
  );
  if (everyoneDone) {
    setTimeout(() => {
      try {
        getStore().exitHive();
      } catch {
        /* swallow */
      }
      appendNarration('All shipped.', 'final_answer');
    }, 1500);
  }
}

function resolveJinInternal(handle: DemoHandle, input: string): void {
  if (handle.stopped) return;
  handle.awaitingResolution = false;

  appendNarration(`Got it — ${input}. Jin, continue.`, 'final_answer');

  commands.addHarnessRule({
    id: `rule-${Date.now()}-jin`,
    rule:
      'For demo-tier persistence, prefer mock data over external API keys',
    why: `User chose "${input}" during Jin's Stripe blocker`,
    timestamp: Date.now(),
    scope: 'task',
    source: 'user-utterance',
  });

  commands.resolveAgent('jin', 'injecting mock track seed');
  commands.updateAgent('jin', { recentFiles: ['lib/billing.ts'] });
}
