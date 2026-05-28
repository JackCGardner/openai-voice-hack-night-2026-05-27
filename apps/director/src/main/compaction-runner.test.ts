/**
 * Unit tests for `compaction-runner.shouldCompact`.
 *
 * Five cases per docs/remaining-phases.md § 7.2:
 *   - 3 triggers: cumulative-tool, idle-large, pre-rotation
 *   - 2 non-triggers: cold session, modest tokens / no idle
 *
 * Headless: pure function, no Electron / fs / fetch.
 */

import { describe, expect, it } from 'vitest';
import {
  CUMULATIVE_TOOL_TRIGGER_TOKENS,
  DEFAULT_IDLE_THRESHOLD_MS,
  IDLE_LARGE_TRIGGER_TOKENS,
  shouldCompact,
  type CompactionStats,
} from './compaction-runner.js';

const NOW = 1_700_000_000_000;

function stats(overrides: Partial<CompactionStats> = {}): CompactionStats {
  return {
    cumulativeToolTokens: 0,
    tokensSinceLastCompaction: 0,
    lastUserActivityAt: NOW,
    nowMs: NOW,
    ...overrides,
  };
}

describe('shouldCompact', () => {
  it('fires "cumulative-tool" when tool output exceeds 50k tokens', () => {
    const verdict = shouldCompact(
      stats({ cumulativeToolTokens: CUMULATIVE_TOOL_TRIGGER_TOKENS + 1 }),
    );
    expect(verdict.fire).toBe(true);
    expect(verdict.reason).toBe('cumulative-tool');
  });

  it('fires "idle-large" when idle ≥ 90s AND tokens > 80k', () => {
    const verdict = shouldCompact(
      stats({
        tokensSinceLastCompaction: IDLE_LARGE_TRIGGER_TOKENS + 1,
        lastUserActivityAt: NOW - (DEFAULT_IDLE_THRESHOLD_MS + 1_000),
        nowMs: NOW,
      }),
    );
    expect(verdict.fire).toBe(true);
    expect(verdict.reason).toBe('idle-large');
  });

  it('fires "pre-rotation" regardless of token counts when opts.preRotation is true', () => {
    const verdict = shouldCompact(stats(), { preRotation: true });
    expect(verdict.fire).toBe(true);
    expect(verdict.reason).toBe('pre-rotation');
  });

  it('does NOT fire on a cold session (no tokens, no idle, no rotation)', () => {
    const verdict = shouldCompact(stats());
    expect(verdict.fire).toBe(false);
    expect(verdict.reason).toBeUndefined();
  });

  it('does NOT fire on modest tokens and a recent user utterance', () => {
    // Tokens past 80k but the user spoke 1s ago → not idle yet.
    // Tool output well below the cumulative trigger.
    const verdict = shouldCompact(
      stats({
        cumulativeToolTokens: 10_000,
        tokensSinceLastCompaction: IDLE_LARGE_TRIGGER_TOKENS + 5_000,
        lastUserActivityAt: NOW - 1_000,
        nowMs: NOW,
      }),
    );
    expect(verdict.fire).toBe(false);
  });

  // Defensive sanity: malformed inputs must not throw or false-positive.
  it('tolerates malformed stats by clamping to safe defaults (no fire)', () => {
    const verdict = shouldCompact({
      cumulativeToolTokens: Number.NaN,
      tokensSinceLastCompaction: -1,
      lastUserActivityAt: Number.NEGATIVE_INFINITY,
      nowMs: Number.POSITIVE_INFINITY,
    } as CompactionStats);
    expect(verdict.fire).toBe(false);
  });

  it('respects a custom idle threshold (does not fire below it)', () => {
    const verdict = shouldCompact(
      stats({
        tokensSinceLastCompaction: IDLE_LARGE_TRIGGER_TOKENS + 1,
        lastUserActivityAt: NOW - 30_000,
        nowMs: NOW,
      }),
      { idleThresholdMs: 60_000 },
    );
    expect(verdict.fire).toBe(false);
  });
});
