/**
 * Mixtape demo simulator.
 *
 * Drives the "happy path" demo from a single timer: four agents dispatched,
 * one (Jin) blocks at ~T+90s on a backend ambiguity, resolves on user input,
 * everyone ships. Purely timer-driven — no Realtime / Codex / IPC needed.
 *
 * The simulator writes to BOTH stores:
 *   - `useDirectorStore` (view-model) — so W2's strip + Hive UI animates.
 *   - `useStore` (canonical) — so the state machine evolves in lockstep,
 *     letting future surfaces (canvas, transcript, harness) ride along.
 *
 * Usage:
 *
 *   import { startMixtapeDemo, resolveJinBlocker } from './state/sim';
 *   startMixtapeDemo();                        // begin
 *   resolveJinBlocker('mock the Stripe gateway');  // unblock Jin
 *
 * The demo is fully cancellable: `startMixtapeDemo()` returns a `stop()`
 * fn that clears all pending timers and leaves the store untouched.
 */

import {
  commands,
  getStore,
  useDirectorStore,
  useStore,
  type Agent as ViewAgent,
} from './store.js';
import type { Agent as CanonicalAgent, HarnessRule } from '../../../shared/state.js';

// ─── Accent palette (mirrors design.pen tokens) ──────────────────────────

const ACCENT_HEX = {
  maya: '#A6E1FF',
  jin: '#FFB37A',
  cleo: '#B6FFA6',
  wren: '#E6A6FF',
} as const satisfies Record<string, `#${string}`>;

// ─── Timeline (ms) ───────────────────────────────────────────────────────

export interface MixtapeTimeline {
  /** Strip enters `speaking` (dispatch narration) at this offset. */
  dispatchSpeakingAt: number;
  /** Agents land as spawning. */
  spawnAt: number;
  /** Agents flip to working + strip enters hive. */
  workingAt: number;
  /** First micro-trail update. */
  firstTrailAt: number;
  /** Cadence of subsequent trail updates. */
  trailIntervalMs: number;
  /** Jin transitions to blocked. */
  jinBlockAt: number;
  /** After resolve, time before agents start completing. */
  postResolveWorkMs: number;
  /** Spacing between agent completions (in order Wren → Cleo → Jin → Maya). */
  completionStaggerMs: number;
}

const COMPRESSED: MixtapeTimeline = {
  dispatchSpeakingAt: 0,
  spawnAt: 600,
  workingAt: 1800,
  firstTrailAt: 5000,
  trailIntervalMs: 4500,
  jinBlockAt: 18000,
  // post-resolve: 6s of work, then completions every 2.5s
  postResolveWorkMs: 6000,
  completionStaggerMs: 2500,
};

const EXTENDED: MixtapeTimeline = {
  dispatchSpeakingAt: 0,
  spawnAt: 600,
  workingAt: 1500,
  firstTrailAt: 8000,
  trailIntervalMs: 9000,
  jinBlockAt: 90_000,
  postResolveWorkMs: 30_000,
  completionStaggerMs: 12_000,
};

// ─── Narrative copy ──────────────────────────────────────────────────────

interface AgentPlan {
  id: 'maya' | 'jin' | 'cleo' | 'wren';
  name: string;
  role: string;
  view: ViewAgent['accent'];
  /** Initial micro-text. */
  task: string;
  /** Initial files breadcrumb (view) / recentFiles (canonical). */
  files: string;
  filesArr: string[];
  /** Trail updates (cycled in order). */
  trail: string[];
  /** Completion summary. */
  done: string;
  doneFiles: string;
  doneFilesArr: string[];
}

const PLAN: AgentPlan[] = [
  {
    id: 'maya',
    name: 'Maya',
    role: 'FRONTEND',
    view: 'maya',
    task: 'wiring the flip animation',
    files: 'PlaylistCard.tsx · CoverArt.tsx',
    filesArr: ['app/PlaylistCard.tsx', 'app/CoverArt.tsx'],
    trail: [
      'PlaylistCard.tsx scaffolded',
      'flip transition at 220ms ease',
      'haptic on tap wired',
      'mobile breakpoint tuned',
    ],
    done: 'PlaylistCard delivered',
    doneFiles: '4 files · 184 lines',
    doneFilesArr: ['app/PlaylistCard.tsx', 'app/CoverArt.tsx', 'app/flip.css'],
  },
  {
    id: 'jin',
    name: 'Jin',
    role: 'BACKEND',
    view: 'jin',
    task: 'sketching /api/generate',
    files: 'lib/generator.ts',
    filesArr: ['lib/generator.ts'],
    trail: [
      'POST /api/generate routed',
      'rate-limit middleware in place',
      'streaming response wired',
      'final integration with Stripe',
    ],
    done: 'generate route shipped',
    doneFiles: '2 files · 96 lines',
    doneFilesArr: ['app/api/generate/route.ts', 'lib/billing.ts'],
  },
  {
    id: 'cleo',
    name: 'Cleo',
    role: 'DATA',
    view: 'cleo',
    task: 'writing Mixtape schema',
    files: 'lib/schema.ts',
    filesArr: ['lib/schema.ts'],
    trail: [
      'Mixtape entity drafted',
      'Track relation modeled',
      'zod validators added',
      'migration generated',
    ],
    done: 'schema + store committed',
    doneFiles: '3 files · 71 lines',
    doneFilesArr: ['lib/schema.ts', 'lib/db.ts', 'drizzle/0001.sql'],
  },
  {
    id: 'wren',
    name: 'Wren',
    role: 'DESIGN',
    view: 'wren',
    task: 'tuning holographic tokens',
    files: 'tailwind.config.ts · themes.ts',
    filesArr: ['tailwind.config.ts', 'app/themes.ts'],
    trail: [
      'palette locked',
      'matte direction adopted',
      'micro-motion easing dialed',
      'theme tokens shipped',
    ],
    done: 'theme tokens shipped',
    doneFiles: '2 files · 48 lines',
    doneFilesArr: ['tailwind.config.ts', 'app/themes.ts'],
  },
];

const JIN_BLOCKER =
  "Stripe key — should I mock the gateway, or wait for production keys?";

// Completion order: smallest scope first so the hive visibly drains.
const COMPLETION_ORDER: AgentPlan['id'][] = ['wren', 'cleo', 'jin', 'maya'];

// ─── Module state ────────────────────────────────────────────────────────

interface DemoHandle {
  timers: Array<ReturnType<typeof setTimeout>>;
  intervals: Array<ReturnType<typeof setInterval>>;
  startedAt: number;
  awaitingResolution: boolean;
  resolve: (input: string) => void;
  stopped: boolean;
}

let active: DemoHandle | null = null;

// ─── Helpers ─────────────────────────────────────────────────────────────

function planToCanonical(p: AgentPlan, status: CanonicalAgent['status']): CanonicalAgent {
  const now = Date.now();
  return {
    id: p.id,
    name: p.name,
    role: capitalize(p.role) as CanonicalAgent['role'],
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

function planToView(p: AgentPlan, status: ViewAgent['status'], task?: string, files?: string): ViewAgent {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    accent: p.view,
    status,
    trail: task ?? p.task,
    files: files ?? p.files,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
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

function schedule(
  handle: DemoHandle,
  fn: () => void,
  delayMs: number,
): void {
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
   * Use the compressed (~60s) timeline ideal for a hackathon demo.
   * `false` runs the canonical 3–4 minute timeline (T+90s block etc.).
   */
  compressed?: boolean;
  /**
   * Goal pill to display in the strip. Defaults to "Mixtape app".
   */
  goal?: string;
  /**
   * Pre-seed a harness rule that the demo would have produced. Defaults to
   * "no gradients ever — user said so during checkout aesthetic review".
   */
  seedHarness?: HarnessRule | null;
  /**
   * Optional callback when Jin blocks. Receives the blocker text and a
   * `resolve(input)` closure. Useful for the UI to capture a user typed
   * answer and route it back into the simulator.
   */
  onBlocked?: (blocker: string, resolve: (input: string) => void) => void;
}

/**
 * Begin the Mixtape demo. Safe to call multiple times — a running demo is
 * stopped and replaced. Returns `{ stop, resolve }` so callers can stop
 * early or unblock Jin programmatically.
 */
export function startMixtapeDemo(
  options: StartMixtapeDemoOptions = {},
): { stop: () => void; resolve: (input: string) => void } {
  if (active) {
    clearHandle(active);
    active = null;
  }

  const timeline = options.compressed === false ? EXTENDED : COMPRESSED;
  const goal = options.goal ?? 'Mixtape app';
  const view = useDirectorStore.getState();
  const seedHarness =
    options.seedHarness === undefined
      ? ({
          id: `rule-${Date.now()}`,
          rule: 'no gradients ever',
          why: 'user said so during checkout aesthetic review',
          timestamp: Date.now(),
          scope: 'project',
          source: 'user-utterance',
        } satisfies HarnessRule)
      : options.seedHarness;

  const handle: DemoHandle = {
    timers: [],
    intervals: [],
    startedAt: Date.now(),
    awaitingResolution: false,
    resolve: () => {
      /* replaced when block fires */
    },
    stopped: false,
  };
  active = handle;

  // Reset stores into a clean demo state.
  view.setGoal(goal);
  view.setStripState('dormant');
  view.setAgents([]);
  commands.setGoal(goal);
  // Canonical: hard reset agents (skip illegal-transition warns).
  useStore.setState({
    agents: {},
    agentOrder: [],
    strip: { kind: 'dormant' },
  });
  if (seedHarness) {
    commands.addHarnessRule(seedHarness);
  }

  // ── T+0: dispatch narration ────────────────────────────────────────
  schedule(
    handle,
    () => {
      view.setStripState('speaking');
      // Canonical setSpeaking requires being out of speaking/escalating —
      // we're in dormant so it's fine.
      const itemId = `item-dispatch-${Date.now()}`;
      try {
        getStore().setSpeaking(itemId, 'commentary');
      } catch {
        /* swallow — sim is non-fatal */
      }
      appendNarration(
        'Dispatching Maya on the flip card, Jin on the API, Cleo on the schema, Wren on theme tokens.',
        'commentary',
      );
    },
    timeline.dispatchSpeakingAt,
  );

  // ── T+spawnAt: agents appear in spawning state ─────────────────────
  schedule(
    handle,
    () => {
      const viewAgents = PLAN.map((p) => planToView(p, 'working'));
      view.setAgents(viewAgents);
      for (const p of PLAN) {
        commands.addAgent(planToCanonical(p, 'spawning'));
      }
    },
    timeline.spawnAt,
  );

  // ── T+workingAt: all working + strip → hive ────────────────────────
  schedule(
    handle,
    () => {
      view.setStripState('hive');
      try {
        getStore().enterHive(PLAN[0]?.id ?? null);
      } catch {
        /* swallow */
      }
      for (const p of PLAN) {
        commands.updateAgent(p.id, { status: 'working' });
      }
      const vAgents = useDirectorStore.getState().agents;
      useDirectorStore.setState({
        agents: vAgents.map((a) => ({ ...a, status: 'working' })),
      });
    },
    timeline.workingAt,
  );

  // ── Periodic trail updates ─────────────────────────────────────────
  const trailIndex: Record<string, number> = { maya: 0, jin: 0, cleo: 0, wren: 0 };
  const startTrails = (): void => {
    if (handle.stopped) return;
    const tick = (): void => {
      if (handle.stopped) return;
      for (const p of PLAN) {
        // Skip blocked Jin; the trail freezes on the blocker.
        const view = useDirectorStore.getState().agents.find((a) => a.id === p.id);
        if (view?.status === 'blocked' || view?.status === 'done') continue;
        const i = trailIndex[p.id]!;
        const next = p.trail[i % p.trail.length]!;
        trailIndex[p.id] = i + 1;
        useDirectorStore.getState().patchAgent(p.id, { trail: next });
        commands.updateAgent(p.id, { currentTask: next });
      }
    };
    schedule(handle, () => {
      tick();
      handle.intervals.push(setInterval(tick, timeline.trailIntervalMs));
    }, timeline.firstTrailAt);
  };
  startTrails();

  // ── T+jinBlockAt: Jin blocks ───────────────────────────────────────
  schedule(
    handle,
    () => {
      // View-model
      useDirectorStore.getState().patchAgent('jin', {
        status: 'blocked',
        trail: 'awaiting Stripe key direction',
        files: '',
      });
      useDirectorStore.getState().setStripState('escalating');
      // Canonical
      commands.blockAgent('jin', JIN_BLOCKER);
      appendNarration(`Jin's blocked — ${JIN_BLOCKER}`, 'commentary');

      handle.awaitingResolution = true;
      handle.resolve = (input: string) => resolveJinInternal(handle, input, timeline);
      options.onBlocked?.(JIN_BLOCKER, handle.resolve);
    },
    timeline.jinBlockAt,
  );

  return {
    stop: () => {
      if (active === handle) active = null;
      clearHandle(handle);
    },
    resolve: (input: string) => {
      if (handle.awaitingResolution) handle.resolve(input);
    },
  };
}

/**
 * Unblock Jin with a typed-or-spoken user answer. No-op if there is no
 * active demo or Jin isn't currently blocked.
 */
export function resolveJinBlocker(input: string): void {
  if (!active) return;
  if (!active.awaitingResolution) return;
  active.resolve(input);
}

/**
 * Returns true while the demo is paused waiting for the user to unblock Jin.
 */
export function isAwaitingResolution(): boolean {
  return Boolean(active?.awaitingResolution);
}

/**
 * Stop any running demo. Safe to call when nothing is running.
 */
export function stopMixtapeDemo(): void {
  if (!active) return;
  clearHandle(active);
  active = null;
}

// ─── Internals ───────────────────────────────────────────────────────────

function resolveJinInternal(
  handle: DemoHandle,
  input: string,
  timeline: MixtapeTimeline,
): void {
  if (handle.stopped) return;
  handle.awaitingResolution = false;

  appendNarration(`Got it — ${input}. Jin, continue.`, 'final_answer');

  // Persist the user's call as a harness rule (the answer often is one).
  commands.addHarnessRule({
    id: `rule-${Date.now()}-jin`,
    rule: input,
    why: 'user resolved blocker',
    timestamp: Date.now(),
    scope: 'task',
    source: 'user-utterance',
  });

  // View-model: Jin back to working, strip back to hive.
  useDirectorStore.getState().patchAgent('jin', {
    status: 'working',
    trail: 'final integration with Stripe',
    files: 'lib/billing.ts',
  });
  useDirectorStore.getState().setStripState('hive');
  // Canonical
  commands.resolveAgent('jin', 'final integration with Stripe');

  // ── Schedule completions ──────────────────────────────────────────
  schedule(
    handle,
    () => beginCompletions(handle, timeline),
    timeline.postResolveWorkMs,
  );
}

function beginCompletions(handle: DemoHandle, timeline: MixtapeTimeline): void {
  if (handle.stopped) return;

  COMPLETION_ORDER.forEach((id, idx) => {
    schedule(
      handle,
      () => {
        if (handle.stopped) return;
        const plan = PLAN.find((p) => p.id === id)!;
        useDirectorStore.getState().patchAgent(plan.id, {
          status: 'done',
          trail: plan.done,
          files: plan.doneFiles,
        });
        commands.completeAgent(plan.id, plan.done);
        commands.updateAgent(plan.id, { recentFiles: plan.doneFilesArr.slice(-3) });
        appendNarration(`${plan.name}: ${plan.done}.`, 'commentary');

        // After the last one, fall back to dormant.
        if (idx === COMPLETION_ORDER.length - 1) {
          schedule(
            handle,
            () => {
              if (handle.stopped) return;
              useDirectorStore.getState().setStripState('dormant');
              try {
                getStore().exitHive();
              } catch {
                /* swallow */
              }
              appendNarration('All shipped.', 'final_answer');
            },
            1200,
          );
        }
      },
      idx * timeline.completionStaggerMs,
    );
  });
}
