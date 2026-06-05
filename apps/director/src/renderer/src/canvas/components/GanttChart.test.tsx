/**
 * Snapshot / behavior tests for GanttChart (docs/voice-genui-spec.md §9).
 *
 * Rendered via `react-dom/server.renderToString` under the vitest `node`
 * environment (no jsdom), matching AgentPod.test.tsx. Covers the two FIXED
 * modes — a PLANNING gantt (all `planned`) and a LIVE gantt (mixed
 * running/blocked/done + a `nowPct` marker) — plus the defensive contract:
 * empty state, out-of-range pct clamping, and unknown-status degradation.
 */

import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Gantt, GanttChart, type GanttTask } from './GanttChart';

// A PLANNING gantt: every task is `planned`, positioned on a timeline.
const PLAN_TASKS: GanttTask[] = [
  { id: 't1', label: 'Scaffold the API', owner: 'Jin', status: 'planned', startPct: 0, endPct: 30, etaLabel: '~30m' },
  { id: 't2', label: 'Wire checkout form', owner: 'Maya', status: 'planned', startPct: 30, endPct: 70, etaLabel: '~45m' },
  { id: 't3', label: 'Migrate orders schema', owner: 'Cleo', status: 'planned', startPct: 20, endPct: 60 },
];

// A LIVE gantt: the SAME ids, now with mixed statuses + a now-line.
const LIVE_TASKS: GanttTask[] = [
  { id: 't1', label: 'Scaffold the API', owner: 'Jin', status: 'done', startPct: 0, endPct: 30, etaLabel: 'done' },
  { id: 't2', label: 'Wire checkout form', owner: 'Maya', status: 'running', startPct: 30, endPct: 70, etaLabel: '~20m left' },
  { id: 't3', label: 'Migrate orders schema', owner: 'Cleo', status: 'blocked', startPct: 20, endPct: 60, etaLabel: 'needs key' },
];

describe('GanttChart — planning mode (all planned)', () => {
  it('renders every planned task with its label, owner, and ETA', () => {
    const html = renderToString(<Gantt title="Checkout flow — plan" tasks={PLAN_TASKS} />);
    expect(html).toContain('Checkout flow — plan');
    expect(html).toContain('Scaffold the API');
    expect(html).toContain('Wire checkout form');
    expect(html).toContain('Migrate orders schema');
    // Owners surface as tags.
    expect(html).toContain('Jin');
    expect(html).toContain('Maya');
    expect(html).toContain('Cleo');
    // ETA labels surface.
    expect(html).toContain('~30m');
    expect(html).toContain('~45m');
  });

  it('marks each row with its status for diffing/color (all planned)', () => {
    const html = renderToString(<Gantt tasks={PLAN_TASKS} />);
    // Every row carries data-status="planned" in plan mode.
    const plannedCount = (html.match(/data-status="planned"/g) ?? []).length;
    expect(plannedCount).toBe(3);
    // The shared eyebrow header is present even without a title.
    expect(html).toContain('canvas-eyebrow');
  });
});

describe('GanttChart — live mode (mixed statuses + nowPct)', () => {
  it('renders mixed statuses and surfaces the status token classes', () => {
    const html = renderToString(<Gantt title="Checkout flow" tasks={LIVE_TASKS} nowPct={48} />);
    expect(html).toContain('data-status="done"');
    expect(html).toContain('data-status="running"');
    expect(html).toContain('data-status="blocked"');
    // status → bar fill reuses the shared --status-* tokens (§9.1).
    expect(html).toContain('var(--status-working)'); // running
    expect(html).toContain('var(--status-blocked)'); // blocked
    expect(html).toContain('var(--status-done)'); // done
  });

  it('draws the now-line when nowPct is provided', () => {
    const withNow = renderToString(<Gantt tasks={LIVE_TASKS} nowPct={48} />);
    const withoutNow = renderToString(<Gantt tasks={LIVE_TASKS} />);
    // The now marker uses the thinking token; present only when nowPct set.
    expect(withNow).toContain('var(--status-thinking)');
    expect(withoutNow).not.toContain('var(--status-thinking)');
    // The bar is positioned ~48% from the left for the now-line.
    expect(withNow).toContain('left:48%');
  });

  it('tints a known owner tag with its agent accent', () => {
    const html = renderToString(<Gantt tasks={LIVE_TASKS} />);
    // Maya/Jin/Cleo are canonical agents → their accent tokens appear.
    expect(html).toContain('var(--accent-maya)');
    expect(html).toContain('var(--accent-jin)');
    expect(html).toContain('var(--accent-cleo)');
  });
});

describe('GanttChart — defensive / edge cases', () => {
  it('renders a calm empty state for no tasks', () => {
    expect(renderToString(<Gantt tasks={[]} />)).toContain('Nothing planned yet.');
    // Undefined tasks also degrades to the empty state (no throw).
    expect(renderToString(<Gantt />)).toContain('Nothing planned yet.');
  });

  it('clamps out-of-range start/end/now pcts without throwing', () => {
    const wild: GanttTask[] = [
      { id: 'w1', label: 'Over the edge', status: 'running', startPct: -50, endPct: 250 },
      { id: 'w2', label: 'Inverted span', status: 'planned', startPct: 80, endPct: 20 },
    ];
    const html = renderToString(<Gantt tasks={wild} nowPct={999} />);
    expect(html).toContain('Over the edge');
    expect(html).toContain('Inverted span');
    // No out-of-range bar geometry leaks into the markup.
    expect(html).not.toContain('left:-50%');
    expect(html).not.toContain('width:250%');
    expect(html).not.toContain('width:-'); // inverted span never goes negative
    // over-edge task clamps to the full track; now-line clamps to 100%.
    expect(html).toContain('left:0%;width:100%');
    expect(html).toContain('left:100%;width:0'); // now-line at clamped 100%
  });

  it('degrades an unknown status to planned styling without throwing', () => {
    const html = renderToString(
      <Gantt
        tasks={[
          // @ts-expect-error — exercise the runtime status fallback
          { id: 'g1', label: 'Ghost task', status: 'totally-unknown' },
        ]}
      />,
    );
    expect(html).toContain('Ghost task');
    expect(html).toContain('data-status="planned"');
  });

  it('renders full-width checklist rows when no start/end pcts are given', () => {
    const html = renderToString(
      <Gantt
        tasks={[
          { id: 'c1', label: 'Checklist item', status: 'planned' },
          { id: 'c2', label: 'Another item', status: 'done' },
        ]}
      />,
    );
    expect(html).toContain('Checklist item');
    expect(html).toContain('Another item');
    // Full-width bar.
    expect(html).toContain('width:100%');
  });

  it('exposes GanttChart as an alias of Gantt', () => {
    expect(GanttChart).toBe(Gantt);
  });
});
