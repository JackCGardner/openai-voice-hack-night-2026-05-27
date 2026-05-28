/**
 * Unit tests for `audio/synth.ts`.
 *
 * Drives `playCue` against a mock `AudioContext` and asserts that the
 * mute env flag turns it into a noop. Headless — no DOM, no Electron.
 *
 * The stub mirrors the Web Audio API surface we actually use:
 *   - `currentTime`
 *   - `createOscillator()` → { connect, start, stop, type, frequency }
 *   - `createGain()` → { gain }
 *   - `destination`
 *   - `state`
 *   - `resume()` / `close()`
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetAudioContextForTests,
  getCueDefinition,
  isAudioMuted,
  playCue,
  type CueName,
} from './synth.js';

interface OscStub {
  type: OscillatorType;
  frequency: {
    setValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

interface GainStub {
  gain: {
    setValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
}

interface CtxStub {
  currentTime: number;
  state: AudioContextState;
  destination: object;
  resume: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  createOscillator: ReturnType<typeof vi.fn>;
  createGain: ReturnType<typeof vi.fn>;
  _oscillators: OscStub[];
  _gains: GainStub[];
}

function makeContext(): CtxStub {
  const ctx: CtxStub = {
    currentTime: 0,
    state: 'running',
    destination: {},
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    _oscillators: [],
    _gains: [],
    createOscillator: vi.fn((): OscStub => {
      const osc: OscStub = {
        type: 'sine',
        frequency: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      ctx._oscillators.push(osc);
      return osc;
    }),
    createGain: vi.fn((): GainStub => {
      const gain: GainStub = {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };
      ctx._gains.push(gain);
      return gain;
    }),
  };
  return ctx;
}

const ORIG_AC = (globalThis as { AudioContext?: unknown }).AudioContext;
const ORIG_MUTE = process.env['DIRECTOR_AUDIO_MUTE'];
let ctx: CtxStub;

beforeEach(() => {
  ctx = makeContext();
  // Wire stub as the global AudioContext ctor — synth.ts does `new AudioContext()`.
  (globalThis as unknown as { AudioContext: () => CtxStub }).AudioContext =
    function MockAC(this: unknown) {
      void this;
      return ctx;
    } as unknown as () => CtxStub;
  _resetAudioContextForTests();
  delete process.env['DIRECTOR_AUDIO_MUTE'];
});

afterEach(() => {
  if (ORIG_AC === undefined) {
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
  } else {
    (globalThis as { AudioContext?: unknown }).AudioContext = ORIG_AC;
  }
  if (ORIG_MUTE === undefined) delete process.env['DIRECTOR_AUDIO_MUTE'];
  else process.env['DIRECTOR_AUDIO_MUTE'] = ORIG_MUTE;
  _resetAudioContextForTests();
});

describe('playCue', () => {
  it.each<CueName>(['confirm', 'tick', 'escalation', 'done', 'halo'])(
    'schedules at least one oscillator for cue `%s`',
    (cue) => {
      const ok = playCue(cue);
      expect(ok).toBe(true);
      expect(ctx._oscillators.length).toBeGreaterThan(0);
      // Each scheduled tone connects osc → gain → destination.
      for (const osc of ctx._oscillators) {
        expect(osc.start).toHaveBeenCalledOnce();
        expect(osc.stop).toHaveBeenCalledOnce();
      }
    },
  );

  it('confirm uses 880Hz sine', () => {
    playCue('confirm');
    expect(ctx._oscillators.length).toBe(1);
    expect(ctx._oscillators[0]!.type).toBe('sine');
    expect(
      ctx._oscillators[0]!.frequency.setValueAtTime,
    ).toHaveBeenCalledWith(880, expect.any(Number));
  });

  it('escalation schedules TWO tones with a frequency glide on the first', () => {
    playCue('escalation');
    expect(ctx._oscillators.length).toBe(2);
    expect(
      ctx._oscillators[0]!.frequency.linearRampToValueAtTime,
    ).toHaveBeenCalled();
  });

  it('done schedules THREE tones (C major arpeggio)', () => {
    playCue('done');
    expect(ctx._oscillators.length).toBe(3);
  });

  it('unknown cue returns false and schedules nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ok = playCue('not-a-real-cue' as CueName);
    expect(ok).toBe(false);
    expect(ctx._oscillators.length).toBe(0);
    warn.mockRestore();
  });

  it('returns false and schedules nothing when DIRECTOR_AUDIO_MUTE=1', () => {
    process.env['DIRECTOR_AUDIO_MUTE'] = '1';
    expect(isAudioMuted()).toBe(true);
    const ok = playCue('confirm');
    expect(ok).toBe(false);
    expect(ctx._oscillators.length).toBe(0);
  });

  it('returns false when no AudioContext is available', () => {
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
    _resetAudioContextForTests();
    const ok = playCue('confirm');
    expect(ok).toBe(false);
  });

  it('resumes a suspended context (browser autoplay path)', () => {
    ctx.state = 'suspended';
    playCue('confirm');
    expect(ctx.resume).toHaveBeenCalled();
  });

  it('exposes a static cue definition table for sanity checks', () => {
    expect(getCueDefinition('confirm')?.tones[0]?.frequency).toBe(880);
    expect(getCueDefinition('tick')?.tones[0]?.frequency).toBe(1320);
    expect(getCueDefinition('halo')?.tones[0]?.duration).toBe(1.2);
    expect(getCueDefinition('not-a-cue' as CueName)).toBeNull();
  });
});
