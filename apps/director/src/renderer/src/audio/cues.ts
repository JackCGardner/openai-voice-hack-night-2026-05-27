/**
 * Audio cue wiring — subscribes to Zustand store transitions and fires
 * the right `playCue(name)` for each.
 *
 * Cue → trigger map (per docs/remaining-phases.md § 5.2):
 *
 *   - `confirm`     a tool call rendered a Canvas (open transition).
 *   - `tick`        an agent's `currentTask` text changed (micro-progress).
 *   - `escalation`  an agent transitioned into `blocked` OR the strip
 *                   entered `escalating` (proactive announcement moment).
 *   - `done`        an agent transitioned into `done` (natural finish).
 *   - `halo`        the realtime FSM entered `rotating` (session-rotation
 *                   swap moment).
 *
 * Each transition fires the cue exactly once — we compare next vs prev
 * snapshot inside the subscribe callback and gate on real edge changes.
 * No "fire every render" — the subscribe is keyed off store.subscribe so
 * it only runs on a state change.
 *
 * Defensive — every cue call is wrapped in try/catch so a broken Audio
 * scheduler never crashes the renderer.
 */

import type { Store } from '../state/store.js';
import { useStore } from '../state/store.js';
import { playCue, type CueName } from './synth.js';

// ─── Snapshot shape we track ─────────────────────────────────────────────
//
// We hold our own small projection rather than diffing the whole store —
// keeps the comparator hot loop O(agents) rather than O(transcript +
// canvas + harness + …).
interface AgentSnapshot {
  status: string;
  currentTask: string | null;
}

interface AudioSnapshot {
  stripKind: string;
  realtimeStatus: string;
  canvasOpen: boolean;
  canvasComponentId: string | null;
  agents: Record<string, AgentSnapshot>;
}

function snapshot(state: Store): AudioSnapshot {
  const agents: Record<string, AgentSnapshot> = {};
  for (const id of Object.keys(state.agents)) {
    const a = state.agents[id];
    if (!a) continue;
    agents[id] = { status: a.status, currentTask: a.currentTask ?? null };
  }
  return {
    stripKind: state.strip.kind,
    realtimeStatus: state.realtime.status,
    canvasOpen: state.canvas.open,
    canvasComponentId: state.canvas.componentId,
    agents,
  };
}

// ─── Pure transition mapper (exported for tests) ─────────────────────────

export interface CueTrigger {
  name: CueName;
  reason: string;
}

/**
 * Pure: given two snapshots, return the cue (if any) to fire. Multiple
 * cues per tick is allowed — they share the AudioContext destination.
 *
 * Exported so unit tests can drive the mapper without a live Zustand
 * subscription (which is awkward in a node test env without DOM).
 */
export function diffCues(
  prev: AudioSnapshot,
  next: AudioSnapshot,
): CueTrigger[] {
  const fired: CueTrigger[] = [];

  // Canvas open edge → confirm cue.
  if (!prev.canvasOpen && next.canvasOpen) {
    fired.push({ name: 'confirm', reason: 'canvas-opened' });
  } else if (
    prev.canvasOpen &&
    next.canvasOpen &&
    prev.canvasComponentId !== next.canvasComponentId
  ) {
    // Canvas swapped to a different component without a hidden phase —
    // treat as a tool ack too (e.g. queue advanced).
    fired.push({ name: 'confirm', reason: 'canvas-swapped' });
  }

  // Strip → escalating: agent blocked, Director about to ask user.
  if (prev.stripKind !== 'escalating' && next.stripKind === 'escalating') {
    fired.push({ name: 'escalation', reason: 'strip-escalating' });
  }

  // Realtime FSM → rotating: session rotation swap moment.
  if (
    prev.realtimeStatus !== 'rotating' &&
    next.realtimeStatus === 'rotating'
  ) {
    fired.push({ name: 'halo', reason: 'rotation-start' });
  }

  // Per-agent transitions: blocked + done + currentTask changes.
  for (const id of Object.keys(next.agents)) {
    const before = prev.agents[id];
    const after = next.agents[id]!;
    if (!before) {
      // New agent — no edge transition, no cue (agent_started lands as
      // a working state; we'd otherwise fire on every spawn).
      continue;
    }
    if (before.status !== 'blocked' && after.status === 'blocked') {
      // Avoid double-firing if the strip-escalating edge already pushed
      // an escalation cue this tick.
      const alreadyFired = fired.some((c) => c.name === 'escalation');
      if (!alreadyFired) {
        fired.push({ name: 'escalation', reason: `agent-blocked:${id}` });
      }
    }
    if (before.status !== 'done' && after.status === 'done') {
      fired.push({ name: 'done', reason: `agent-done:${id}` });
    }
    if (
      before.status === 'working' &&
      after.status === 'working' &&
      before.currentTask !== after.currentTask &&
      after.currentTask
    ) {
      fired.push({ name: 'tick', reason: `agent-tick:${id}` });
    }
  }

  return fired;
}

// ─── Live wiring ─────────────────────────────────────────────────────────

let unsubscribe: (() => void) | null = null;

/**
 * Subscribe to store changes and dispatch cues. Idempotent — calling
 * twice without `teardownAudioCues()` keeps the existing subscription.
 *
 * Returns a teardown function for symmetry with the audio mount hook in
 * `useAudioCuesMount`.
 */
export function startAudioCues(): () => void {
  if (unsubscribe) return unsubscribe;
  let prev = snapshot(useStore.getState());
  unsubscribe = useStore.subscribe((state) => {
    const next = snapshot(state);
    const triggers = diffCues(prev, next);
    prev = next;
    for (const t of triggers) {
      try {
        playCue(t.name);
      } catch (err) {
        console.warn(
          `[audio/cues] playCue(${t.name}) failed (${t.reason})`,
          err,
        );
      }
    }
  });
  return () => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };
}

export function teardownAudioCues(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
