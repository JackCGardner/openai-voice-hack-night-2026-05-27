/**
 * Unit tests for the consult-context forwarding (cleanup 1).
 *
 * `consultDirector` used to pass only `args.prompt` to the agent brain,
 * silently dropping the structured `args.context` (current file, active
 * agents, recent decisions) the voice layer assembles. `buildBrainPrompt`
 * is the pure helper that prepends a compact, LLM-readable context block to
 * the prompt — these tests pin its behavior so a future refactor can't
 * quietly re-drop the context.
 *
 * Headless: `planner.ts` imports `{ ipcMain }` from 'electron', so we mock
 * electron before importing it. No network, no BrowserWindow — `buildBrainPrompt`
 * is a pure function.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: {
    handle: () => {},
    on: () => {},
    removeHandler: () => {},
    removeAllListeners: () => {},
  },
  BrowserWindow: class {},
}));

import { buildBrainPrompt } from './planner.js';

describe('buildBrainPrompt — consult-context forwarding', () => {
  it('returns the bare prompt when no context is supplied', () => {
    expect(buildBrainPrompt({ prompt: 'design a landing page' })).toBe(
      'design a landing page',
    );
  });

  it('returns the bare prompt when context is empty', () => {
    expect(buildBrainPrompt({ prompt: 'do the thing', context: {} })).toBe(
      'do the thing',
    );
  });

  it('prepends a labeled context block before the prompt', () => {
    const out = buildBrainPrompt({
      prompt: 'refactor this',
      context: { currentFile: 'src/main/index.ts' },
    });
    // Context block comes first, then a blank line, then the prompt.
    expect(out.startsWith('## Caller context (from the voice layer)')).toBe(true);
    expect(out).toContain('- currentFile: src/main/index.ts');
    expect(out.endsWith('refactor this')).toBe(true);
    expect(out).toMatch(/index\.ts\n\nrefactor this$/);
  });

  it('renders scalars, arrays, and nested objects compactly', () => {
    const out = buildBrainPrompt({
      prompt: 'continue',
      context: {
        currentFile: 'a.ts',
        activeAgents: ['maya', 'jin'],
        recentDecisions: [{ id: 'd1', text: 'ship it' }],
        turnCount: 3,
        rotating: false,
      },
    });
    expect(out).toContain('- currentFile: a.ts');
    // Arrays of strings join with commas.
    expect(out).toContain('- activeAgents: maya, jin');
    // Arrays of objects JSON-stringify each entry.
    expect(out).toContain('- recentDecisions: {"id":"d1","text":"ship it"}');
    // Numbers + booleans stringify.
    expect(out).toContain('- turnCount: 3');
    expect(out).toContain('- rotating: false');
  });

  it('skips null / undefined / empty values (no blank bullets)', () => {
    const out = buildBrainPrompt({
      prompt: 'go',
      context: {
        currentFile: 'a.ts',
        nothing: null,
        missing: undefined,
        blank: '   ',
        emptyList: [],
      },
    });
    expect(out).toContain('- currentFile: a.ts');
    expect(out).not.toContain('nothing');
    expect(out).not.toContain('missing');
    expect(out).not.toContain('blank');
    expect(out).not.toContain('emptyList');
  });

  it('clamps a runaway field so it cannot dominate the prompt', () => {
    const huge = 'x'.repeat(5000);
    const out = buildBrainPrompt({ prompt: 'go', context: { blob: huge } });
    // 600-char clamp (597 + '...'); the full 5000-char value never appears.
    expect(out).not.toContain(huge);
    expect(out).toContain('...');
    // The clamped bullet stays well under the raw length.
    expect(out.length).toBeLessThan(huge.length);
  });
});
