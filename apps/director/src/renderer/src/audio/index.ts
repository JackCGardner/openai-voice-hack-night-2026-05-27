/**
 * Audio cue module entry point.
 *
 * The renderer's `useAudioCuesMount` hook (apps/director/src/renderer/src/
 * hooks/useAudioCuesMount.ts) dynamically imports this module on mount
 * and calls `initAudioCues()`. Returning a teardown function gives the
 * hook a deterministic cleanup path on unmount / HMR.
 *
 * Headless: importing this file has no side effects — `initAudioCues()`
 * must be called explicitly.
 */

import { startAudioCues, teardownAudioCues } from './cues.js';

export { playCue, isAudioMuted } from './synth.js';
export type { CueName, PlayCueOptions } from './synth.js';
export { diffCues } from './cues.js';

/**
 * Subscribe to store transitions and route them to `playCue`. Returns a
 * teardown function the host (`useAudioCuesMount`) can call on unmount.
 *
 * Idempotent: a second `initAudioCues()` without teardown returns the
 * same handle. See `cues.ts` for the cue → transition map.
 */
export function initAudioCues(): () => void {
  startAudioCues();
  return () => teardownAudioCues();
}
