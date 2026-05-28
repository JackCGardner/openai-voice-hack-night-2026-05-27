import { useEffect, useRef, type JSX } from 'react';
import { useReducedMotion } from 'framer-motion';

const BAR_COUNT = 21;
const BAR_MIN_HEIGHT = 4;
const BAR_MAX_HEIGHT = 22;

interface ListeningStripProps {
  /** Live mic MediaStream from W1's useRealtime(). Optional; falls back to ambient noise. */
  audioStream?: MediaStream | null;
  /** Color tint — green by default (Listening), coral for Speaking. */
  tint?: 'working' | 'maya';
  /** Mirror the waveform vertically (used by SpeakingStrip). */
  mirrored?: boolean;
  ariaLabel?: string;
}

/**
 * Listening Strip — live mic waveform.
 * Pencil source: design.pen / Strip / Listening (WTc1y).
 *
 * Geometry: 12px wide × 180px tall pill, 6px radius (same shape as Dormant).
 * Visual: vertical column of 21 narrow bars, heights driven by an
 *         AnalyserNode if a MediaStream is supplied; otherwise a smooth
 *         pseudo-noise idle.
 * A11y:   honors prefers-reduced-motion (static mid-amplitude fill).
 */
export function ListeningStrip({
  audioStream,
  tint = 'working',
  mirrored = false,
  ariaLabel = 'Listening',
}: ListeningStripProps): JSX.Element {
  const reduced = useReducedMotion();
  const barsRef = useRef<Array<HTMLDivElement | null>>([]);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const freqRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    if (reduced) {
      barsRef.current.forEach((el, i) => {
        if (!el) return;
        const center = BAR_COUNT / 2;
        const dist = Math.abs(i - center) / center;
        el.style.height = `${BAR_MIN_HEIGHT + (1 - dist) * (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT) * 0.4}px`;
      });
      return;
    }

    let stopped = false;

    // Attach analyser if we have a stream.
    if (audioStream && audioStream.getAudioTracks().length > 0) {
      try {
        const ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(audioStream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.7;
        src.connect(analyser);
        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
        sourceRef.current = src;
        freqRef.current = new Uint8Array(analyser.frequencyBinCount);
      } catch {
        // Fall through to fallback path.
      }
    }

    const start = performance.now();

    const tick = (now: number) => {
      if (stopped) return;

      const t = (now - start) / 1000;
      const analyser = analyserRef.current;
      const freq = freqRef.current;

      if (analyser && freq) {
        // Cast for TS DOM lib variance across AudioBuffer types.
        analyser.getByteFrequencyData(freq as unknown as Uint8Array<ArrayBuffer>);
      }

      for (let i = 0; i < BAR_COUNT; i++) {
        const el = barsRef.current[i];
        if (!el) continue;
        let amp: number;
        if (analyser && freq) {
          const idx = Math.min(freq.length - 1, Math.floor((i / BAR_COUNT) * freq.length));
          amp = (freq[idx] ?? 0) / 255;
        } else {
          // Smooth pseudo-noise: two out-of-phase sines per bar + slow envelope.
          const phase = i * 0.35;
          const env = 0.35 + 0.35 * Math.sin(t * 1.6 + phase);
          const wave = 0.25 + 0.25 * Math.sin(t * 4.1 + phase * 1.7);
          amp = env * wave * 2.2;
        }
        const h = BAR_MIN_HEIGHT + Math.max(0, Math.min(1, amp)) * (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT);
        el.style.height = `${h.toFixed(1)}px`;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      sourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      analyserRef.current = null;
      sourceRef.current = null;
      freqRef.current = null;
    };
  }, [audioStream, reduced]);

  const fill = tint === 'maya' ? 'var(--accent-maya)' : 'var(--status-working)';
  const glow =
    tint === 'maya'
      ? '0 0 32px rgba(224, 120, 86, 0.22)'
      : 'var(--shadow-listening)';

  return (
    <div className="strip-root">
      <div
        className="strip-small"
        role="status"
        aria-label={ariaLabel}
        style={{
          background: '#0E0E10D9',
          boxShadow: `${glow}, var(--shadow-strip)`,
          borderColor: 'rgba(255,255,255,0.18)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: mirrored ? 'column-reverse' : 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 3,
            padding: '10px 0',
          }}
        >
          {Array.from({ length: BAR_COUNT }).map((_, i) => (
            <div
              key={i}
              ref={(el) => {
                barsRef.current[i] = el;
              }}
              style={{
                width: 3,
                height: BAR_MIN_HEIGHT,
                background: fill,
                borderRadius: 1.5,
                willChange: 'height',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
