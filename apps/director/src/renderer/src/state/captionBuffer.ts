/**
 * Caption buffer — a tiny subscribable ring of words emitted by the
 * Realtime assistant transcript stream. Decoupled from the canonical
 * Zustand store because:
 *
 *   - Captions update at word-level granularity (~10Hz) and we don't want
 *     to fan out re-renders to every Strip subscriber.
 *   - The word-timing metadata (`at`) is presentation-layer concern, not
 *     persisted history (the canonical `transcript` slice owns the full
 *     sentences once `response.output_audio_transcript.done` fires).
 *
 * Pure module. No Electron, no DOM. Safe to import from tests.
 *
 * Spec: docs/remaining-phases.md § 5.1.
 */

export interface CaptionWord {
  /** Word text (no surrounding whitespace). */
  text: string;
  /** ms epoch when this word landed in the buffer. */
  at: number;
  /** Stable id per response, used for React keys. */
  id: string;
}

const MAX_BUFFER_WORDS = 32;

let buffer: CaptionWord[] = [];
const subscribers: Set<(buf: readonly CaptionWord[]) => void> = new Set();

function notify(): void {
  for (const cb of subscribers) {
    try {
      cb(buffer);
    } catch (err) {
      // Never let a subscriber crash the producer.
      // eslint-disable-next-line no-console
      console.warn('[captionBuffer] subscriber threw', err);
    }
  }
}

export function getCaptionBuffer(): readonly CaptionWord[] {
  return buffer;
}

export function subscribeCaptionBuffer(
  cb: (buf: readonly CaptionWord[]) => void,
): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/**
 * Append a delta to the caption buffer.
 *
 * Splits the delta on whitespace and pushes each non-empty word with its
 * own timestamp. The `responseId` is used to seed the React `id` so
 * sequential responses don't collide on key reuse.
 *
 * Defensive — accepts garbage and noop's: non-string delta, empty string,
 * absent `responseId` all return without effect.
 */
export function appendCaptionDelta(delta: unknown, responseId?: unknown): void {
  if (typeof delta !== 'string' || delta.length === 0) return;
  const rid = typeof responseId === 'string' ? responseId : 'r';
  const now = Date.now();
  const pieces = delta.split(/\s+/).filter((p) => p.length > 0);
  if (pieces.length === 0) return;
  for (let i = 0; i < pieces.length; i += 1) {
    buffer.push({
      text: pieces[i]!,
      at: now,
      id: `${rid}-${buffer.length + i}`,
    });
  }
  if (buffer.length > MAX_BUFFER_WORDS) {
    buffer = buffer.slice(-MAX_BUFFER_WORDS);
  }
  notify();
}

/** Test-only: reset to a known empty state. */
export function _resetCaptionBufferForTests(): void {
  buffer = [];
  notify();
}
