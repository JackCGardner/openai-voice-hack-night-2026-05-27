/**
 * Unit tests for the pure caption-window helpers extracted from Captions.tsx.
 *
 * Headless — no DOM, no Electron, no React render. Drives only the pure
 * `computeCaptionWindow` + `wordAlpha` functions against synthetic buffers.
 */

import { describe, expect, it } from 'vitest';
import { computeCaptionWindow, wordAlpha } from './Captions.js';
import type { CaptionWord } from '../state/captionBuffer.js';

function word(text: string, at: number, id = text): CaptionWord {
  return { text, at, id };
}

describe('computeCaptionWindow', () => {
  it('returns hidden when buffer is empty', () => {
    const result = computeCaptionWindow([], 1000);
    expect(result.hidden).toBe(true);
    expect(result.rowOpacity).toBe(0);
    expect(result.words).toEqual([]);
  });

  it('returns full opacity within the persist window', () => {
    const buf = [word('hello', 1000), word('world', 1100)];
    const result = computeCaptionWindow(buf, 1200);
    expect(result.hidden).toBe(false);
    expect(result.rowOpacity).toBe(1);
    expect(result.words.length).toBe(2);
  });

  it('linearly fades the row between persist + silence', () => {
    const buf = [word('hi', 0)];
    // 1400ms = end of persist; 1640ms = end of fade-out.
    const midFade = computeCaptionWindow(buf, 1520); // 120ms into 240ms fade
    expect(midFade.hidden).toBe(false);
    expect(midFade.rowOpacity).toBeGreaterThan(0.4);
    expect(midFade.rowOpacity).toBeLessThan(0.6);

    const nearEnd = computeCaptionWindow(buf, 1639);
    expect(nearEnd.rowOpacity).toBeGreaterThan(0);
    expect(nearEnd.rowOpacity).toBeLessThanOrEqual(0.05);
  });

  it('returns fully hidden past the silence timeout (>2000ms)', () => {
    const buf = [word('hi', 0)];
    const result = computeCaptionWindow(buf, 2500);
    expect(result.hidden).toBe(true);
    expect(result.rowOpacity).toBe(0);
    expect(result.words).toEqual([]);
  });

  it('caps the visible words at 12 (latest tail)', () => {
    const buf: CaptionWord[] = [];
    for (let i = 0; i < 20; i += 1) {
      buf.push(word(`w${i}`, i * 50, `id-${i}`));
    }
    const result = computeCaptionWindow(buf, buf[buf.length - 1]!.at);
    expect(result.words.length).toBe(12);
    expect(result.words[0]!.text).toBe('w8');
    expect(result.words[11]!.text).toBe('w19');
  });

  it('tolerates non-array input by returning hidden', () => {
    // @ts-expect-error — defensive test against bad runtime data.
    const result = computeCaptionWindow(null, 1000);
    expect(result.hidden).toBe(true);
  });
});

describe('wordAlpha', () => {
  it('is 0 before the word lands', () => {
    expect(wordAlpha(word('x', 1000), 999)).toBe(0);
    expect(wordAlpha(word('x', 1000), 1000)).toBe(0);
  });

  it('ramps linearly across the 80ms fade-in', () => {
    const w = word('x', 0);
    expect(wordAlpha(w, 40)).toBe(0.5);
    expect(wordAlpha(w, 80)).toBe(1);
  });

  it('is fully visible after the fade-in window', () => {
    expect(wordAlpha(word('x', 0), 500)).toBe(1);
    expect(wordAlpha(word('x', 0), 10000)).toBe(1);
  });
});
