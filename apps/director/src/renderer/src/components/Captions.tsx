/**
 * Captions — fading subtitle for Director's spoken output.
 *
 * Anchored 24px below the Strip. Renders the last ~12 words from Director's
 * assistant transcript stream. Each word fades in 80ms, persists 1.4s past
 * the final word in its window, and fades out 240ms. The whole row stops
 * rendering when the transcript is silent for >2s. No background — text
 * shadow + drop shadow handle legibility over light or dark wallpapers.
 *
 * Spec: docs/remaining-phases.md § 5.1.
 *
 * Data flow:
 *   RealtimeClient `event` → useAssistantCaptionStream hook (subscribed
 *   from App.tsx) appends `response.output_audio_transcript.delta` words
 *   into a module-level subscribable buffer → Captions reads the buffer.
 *   Pure (no Electron, no IPC).
 *
 * The word-window selection logic is extracted to `computeCaptionWindow`
 * so it can be unit-tested without the DOM. See `Captions.test.ts`.
 */

import { useEffect, useState, type JSX } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  subscribeCaptionBuffer,
  getCaptionBuffer,
  type CaptionWord,
} from '../state/captionBuffer.js';

// ─── Tunables (per docs/remaining-phases.md § 5.1) ─────────────────────────

const MAX_VISIBLE_WORDS = 12;
/** ms — fade in per word. */
const WORD_FADE_IN_MS = 80;
/** ms — persistence past the final word's appearance. */
const WORD_PERSIST_MS = 1400;
/** ms — fade out for the whole row once persist expires. */
const ROW_FADE_OUT_MS = 240;
/** ms — silence after the last word that fully hides the captions row. */
const SILENCE_TIMEOUT_MS = 2000;
/** UI tick — how often we re-evaluate `now` against persist/fade timers. */
const TICK_MS = 80;

// ─── Pure helper: compute the visible caption window ───────────────────────

export interface CaptionWindowResult {
  /** Words to display, oldest → newest, capped at MAX_VISIBLE_WORDS. */
  words: CaptionWord[];
  /** 0..1 alpha of the row as a whole — handles the trailing fade-out. */
  rowOpacity: number;
  /** True when the row should be removed from the DOM entirely. */
  hidden: boolean;
}

/**
 * Pure: given a buffer of dated words and a `now` timestamp, decide which
 * words appear in the caption row and how transparent it is overall.
 *
 * Behavior:
 *   - Take the last MAX_VISIBLE_WORDS words from the buffer.
 *   - If no words at all → `hidden`.
 *   - Let `lastAt = max(word.at)`.
 *   - If `now - lastAt > SILENCE_TIMEOUT_MS` → fully hidden (return [] + 0).
 *   - If `now - lastAt > WORD_PERSIST_MS` → row begins fading out linearly
 *     across ROW_FADE_OUT_MS.
 *   - Otherwise rowOpacity = 1.
 *
 * No side effects. Safe to call at any cadence.
 */
export function computeCaptionWindow(
  buffer: readonly CaptionWord[],
  now: number,
): CaptionWindowResult {
  if (!Array.isArray(buffer) || buffer.length === 0) {
    return { words: [], rowOpacity: 0, hidden: true };
  }
  const tail = buffer.slice(-MAX_VISIBLE_WORDS);
  const lastAt = tail.reduce((m, w) => (w.at > m ? w.at : m), 0);
  const sinceLast = Math.max(0, now - lastAt);

  if (sinceLast >= SILENCE_TIMEOUT_MS) {
    return { words: [], rowOpacity: 0, hidden: true };
  }
  if (sinceLast <= WORD_PERSIST_MS) {
    return { words: tail, rowOpacity: 1, hidden: false };
  }
  // sinceLast > WORD_PERSIST_MS and < SILENCE_TIMEOUT_MS → linear fade-out.
  const fadeProgress = (sinceLast - WORD_PERSIST_MS) / ROW_FADE_OUT_MS;
  const rowOpacity = Math.max(0, 1 - fadeProgress);
  return {
    words: tail,
    rowOpacity,
    hidden: rowOpacity <= 0,
  };
}

// ─── Per-word fade-in alpha ────────────────────────────────────────────────

/**
 * Linear fade-in across WORD_FADE_IN_MS from word.at. Pure. Exposed for
 * tests + the component itself.
 */
export function wordAlpha(word: CaptionWord, now: number): number {
  const dt = now - word.at;
  if (dt <= 0) return 0;
  if (dt >= WORD_FADE_IN_MS) return 1;
  return dt / WORD_FADE_IN_MS;
}

// ─── Component ─────────────────────────────────────────────────────────────

/**
 * Subscribes to the global caption buffer (fed by `useAssistantCaptionStream`
 * in App.tsx) and renders the fading subtitle row. Safe to mount when no
 * caption data exists — it renders nothing.
 */
export function Captions(): JSX.Element | null {
  const reduced = useReducedMotion();
  const [, setTick] = useState(0);
  const [buffer, setBuffer] = useState<readonly CaptionWord[]>(() =>
    getCaptionBuffer(),
  );

  // Subscribe to caption-buffer mutations.
  useEffect(() => {
    return subscribeCaptionBuffer((next) => setBuffer(next));
  }, []);

  // Drive a low-frequency tick so fade-out timers progress even when no new
  // words arrive. Cheap (80ms interval, single setState bump).
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => (n + 1) % 1_000_000), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const now = Date.now();
  const { words, rowOpacity, hidden } = computeCaptionWindow(buffer, now);

  if (hidden || words.length === 0) {
    return null;
  }

  return (
    <div className="captions-root" aria-hidden>
      <motion.div
        className="captions-row"
        style={{ opacity: rowOpacity }}
        initial={reduced ? { opacity: rowOpacity } : { opacity: 0 }}
        animate={{ opacity: rowOpacity }}
        transition={{ duration: reduced ? 0 : ROW_FADE_OUT_MS / 1000 }}
      >
        {words.map((word) => {
          const alpha = reduced ? 1 : wordAlpha(word, now);
          return (
            <span
              key={`${word.id}-${word.at}`}
              className="captions-word"
              style={{ opacity: alpha }}
            >
              {word.text}
            </span>
          );
        })}
      </motion.div>
    </div>
  );
}
