/**
 * Audio cue synth — pure Web Audio API, no audio files.
 *
 * Spec: docs/remaining-phases.md § 5.2 + docs/ux-design.md Pass 5
 * (sound palette). Five cues:
 *
 *   - `confirm`     880 Hz sine, 80ms, -12dB  — tool-call ack
 *   - `tick`        1320 Hz square, 30ms, -18dB — agent micro-progress
 *   - `escalation`  660 → 440 Hz dual-tone, 180ms each, -10dB — agent blocked
 *   - `done`        C major triad arpeggio (523/659/784 Hz), 60ms each, -12dB — agent done
 *   - `halo`        220 Hz sine fade in/out, 1200ms, -20dB — session rotation
 *
 * `playCue(name, opts?)` is the only public entry point. Lazily
 * constructs a single shared `AudioContext` on first play (browser
 * autoplay policy: needs user gesture, but Director's first cue always
 * follows the hotkey press — so we're safe in practice).
 *
 * Mute via `DIRECTOR_AUDIO_MUTE=1` env var (set at build time in Vite's
 * `import.meta.env`) — turns `playCue` into a noop. Useful for tests, for
 * CI snapshot recordings, and for a future settings toggle.
 *
 * Headless-safe: the module loads without an AudioContext (no globals
 * resolved on import). All side effects are inside `playCue`. Tests can
 * stub the global `AudioContext` and assert it was called with the right
 * frequencies / durations.
 */

// ─── Cue palette (single source of truth for tests + cues.ts) ────────────

export type CueName =
  | 'confirm'
  | 'tick'
  | 'escalation'
  | 'done'
  | 'halo';

export interface PlayCueOptions {
  /** Multiplicative gain (linear) layered on top of the cue's base level. */
  gain?: number;
  /** Override the scheduling start time. Defaults to `now`. */
  startAt?: number;
}

interface ToneSpec {
  frequency: number;
  type: OscillatorType;
  /** Seconds. */
  duration: number;
  /** Linear amplitude 0..1 (mapped from -dB to linear at play time). */
  level: number;
  /** Optional frequency ramp end (used by `escalation`'s first beat). */
  toFrequency?: number;
  /** Seconds offset from the cue's startAt. */
  offset: number;
  /** Attack + release shaping (seconds). Soft edges prevent click pops. */
  attack?: number;
  release?: number;
}

interface CueDefinition {
  tones: ToneSpec[];
}

const dBtoLinear = (db: number): number => Math.pow(10, db / 20);

// Per docs/ux-design.md Pass 5 — keep these numbers literal so a designer
// reading the source matches the design doc byte-for-byte.
const CUE_TABLE: Record<CueName, CueDefinition> = {
  confirm: {
    tones: [
      {
        frequency: 880,
        type: 'sine',
        duration: 0.08,
        level: dBtoLinear(-12),
        offset: 0,
        attack: 0.005,
        release: 0.02,
      },
    ],
  },
  tick: {
    tones: [
      {
        frequency: 1320,
        type: 'square',
        duration: 0.03,
        level: dBtoLinear(-18),
        offset: 0,
        attack: 0.002,
        release: 0.01,
      },
    ],
  },
  escalation: {
    tones: [
      {
        frequency: 660,
        toFrequency: 440,
        type: 'sine',
        duration: 0.18,
        level: dBtoLinear(-10),
        offset: 0,
        attack: 0.005,
        release: 0.03,
      },
      {
        frequency: 440,
        type: 'sine',
        duration: 0.18,
        level: dBtoLinear(-10),
        offset: 0.18,
        attack: 0.005,
        release: 0.03,
      },
    ],
  },
  done: {
    tones: [
      {
        frequency: 523,
        type: 'sine',
        duration: 0.06,
        level: dBtoLinear(-12),
        offset: 0,
        attack: 0.003,
        release: 0.02,
      },
      {
        frequency: 659,
        type: 'sine',
        duration: 0.06,
        level: dBtoLinear(-12),
        offset: 0.06,
        attack: 0.003,
        release: 0.02,
      },
      {
        frequency: 784,
        type: 'sine',
        duration: 0.06,
        level: dBtoLinear(-12),
        offset: 0.12,
        attack: 0.003,
        release: 0.025,
      },
    ],
  },
  halo: {
    tones: [
      {
        frequency: 220,
        type: 'sine',
        duration: 1.2,
        level: dBtoLinear(-20),
        offset: 0,
        attack: 0.35,
        release: 0.45,
      },
    ],
  },
};

/** Read-only view exposed for tests. */
export function getCueDefinition(name: CueName): CueDefinition | null {
  return CUE_TABLE[name] ?? null;
}

// ─── Module-level lazy AudioContext singleton ────────────────────────────

type AudioCtor = typeof globalThis.AudioContext;

interface AudioGlobals {
  AudioContext?: AudioCtor;
  webkitAudioContext?: AudioCtor;
}

let sharedContext: AudioContext | null = null;

function resolveCtor(): AudioCtor | null {
  if (typeof globalThis === 'undefined') return null;
  const g = globalThis as unknown as AudioGlobals;
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/**
 * Returns the shared `AudioContext` or null when running headless / in a
 * test environment without a stub. Safe to call repeatedly — first call
 * constructs, subsequent calls reuse.
 */
function getContext(): AudioContext | null {
  if (sharedContext) return sharedContext;
  const Ctor = resolveCtor();
  if (!Ctor) return null;
  try {
    sharedContext = new Ctor();
    return sharedContext;
  } catch (err) {
    console.warn('[audio/synth] AudioContext construction failed', err);
    sharedContext = null;
    return null;
  }
}

// ─── Mute flag (env-driven) ──────────────────────────────────────────────

interface ProcessLike {
  env?: Record<string, string | undefined>;
}

/**
 * Reads the mute flag from either Node process.env (tests / SSR) or
 * Vite's `import.meta.env` (runtime). Both code paths defensive — the
 * absence of either is treated as "not muted".
 *
 * Truthy mute values: '1', 'true', 'yes' (case-insensitive).
 */
export function isAudioMuted(): boolean {
  let raw: string | undefined;
  try {
    const proc = (globalThis as unknown as { process?: ProcessLike }).process;
    raw = proc?.env?.['DIRECTOR_AUDIO_MUTE'];
  } catch {
    raw = undefined;
  }
  if (raw == null) {
    try {
      const env = (
        import.meta as unknown as { env?: Record<string, unknown> }
      ).env;
      const v = env?.['DIRECTOR_AUDIO_MUTE'] ?? env?.['VITE_DIRECTOR_AUDIO_MUTE'];
      if (typeof v === 'string') raw = v;
      else if (typeof v === 'boolean') raw = v ? '1' : '0';
    } catch {
      // import.meta.env is unavailable in pure node — fall through.
    }
  }
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

// ─── Tone scheduling ─────────────────────────────────────────────────────

function scheduleTone(
  ctx: AudioContext,
  tone: ToneSpec,
  startAt: number,
  gainMultiplier: number,
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = tone.type;
  osc.frequency.setValueAtTime(tone.frequency, startAt);
  if (typeof tone.toFrequency === 'number') {
    // Linear glide to the secondary frequency over the tone's duration.
    osc.frequency.linearRampToValueAtTime(tone.toFrequency, startAt + tone.duration);
  }

  // Apply an ADSR-ish envelope so each cue avoids click pops at start /
  // end. Attack defaults to ~5ms; release to ~20ms. `halo` overrides
  // with longer attack/release for the soft swell.
  const attack = Math.max(0.001, tone.attack ?? 0.005);
  const release = Math.max(0.001, tone.release ?? 0.02);
  const peak = Math.max(0, Math.min(1, tone.level * gainMultiplier));
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(peak, startAt + attack);
  const releaseStart = Math.max(
    startAt + attack,
    startAt + tone.duration - release,
  );
  gain.gain.setValueAtTime(peak, releaseStart);
  gain.gain.linearRampToValueAtTime(0, startAt + tone.duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(startAt);
  osc.stop(startAt + tone.duration + 0.01);
}

// ─── Public entry point ──────────────────────────────────────────────────

/**
 * Play a named cue through the shared AudioContext. Returns true if the
 * cue was scheduled, false if it was muted / no context / unknown cue.
 *
 * Never throws — any failure logs a single warn and returns false.
 */
export function playCue(name: CueName, opts: PlayCueOptions = {}): boolean {
  if (isAudioMuted()) return false;
  const def = CUE_TABLE[name];
  if (!def) {
    console.warn(`[audio/synth] unknown cue name: ${String(name)}`);
    return false;
  }
  const ctx = getContext();
  if (!ctx) return false;
  // Browser autoplay policy: if the context is suspended (user hasn't
  // interacted yet) try to resume. Failure is non-fatal.
  if (ctx.state === 'suspended') {
    void ctx.resume().catch((err) => {
      console.warn('[audio/synth] AudioContext.resume rejected', err);
    });
  }
  const gainMultiplier =
    typeof opts.gain === 'number' && Number.isFinite(opts.gain)
      ? Math.max(0, opts.gain)
      : 1;
  const startAt =
    typeof opts.startAt === 'number' && Number.isFinite(opts.startAt)
      ? opts.startAt
      : ctx.currentTime;
  try {
    for (const tone of def.tones) {
      scheduleTone(ctx, tone, startAt + tone.offset, gainMultiplier);
    }
    return true;
  } catch (err) {
    console.warn(`[audio/synth] scheduling failed for cue ${name}`, err);
    return false;
  }
}

/** Test-only: drop the cached AudioContext so a new test can stub afresh. */
export function _resetAudioContextForTests(): void {
  try {
    void sharedContext?.close?.();
  } catch {
    // ignore — closing is best-effort.
  }
  sharedContext = null;
}
