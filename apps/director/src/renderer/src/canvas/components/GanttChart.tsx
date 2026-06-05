/**
 * GanttChart (`gantt`) — plan + live-progress chart for the Canvas window.
 *
 * One component, two jobs (docs/voice-genui-spec.md §9):
 *   1. PLANNING — break multi-step / multi-agent work into ordered rows
 *      (all `status: 'planned'`), optionally positioned on a timeline.
 *   2. LIVE PROGRESS — the SAME plan re-pushed with updated `status` /
 *      `nowPct` as work advances. Rows are keyed by `task.id` so a status
 *      flip animates the bar (color + width + the now-line) IN PLACE via
 *      framer-motion `layout` — never a full remount.
 *
 * Visual language is shared with AgentPod / AgentRow: bars use the same
 * `--status-*` tokens so a plan and the live Hive read as one system, and
 * a known owner name (Maya/Jin/Cleo/Wren) tints its tag with the matching
 * `--accent-*` color (best-effort).
 *
 * Display-only: no `onRespond` / selection (§9.2). Renders defensively —
 * tolerates missing/`null`/out-of-range fields and never throws (the
 * CanvasErrorBoundary catches throws, but a calm empty state is the
 * contract). Fully inline-styled (design tokens only) like AgentPod, so it
 * renders identically under `renderToString` in the snapshot tests.
 *
 * Exported as both `Gantt` (the name the CanvasApp dispatcher + spec wire
 * to) and `GanttChart` (matching the file name); `GanttProps` is the FIXED
 * prop shape from §9.1.
 *
 * Spec: docs/voice-genui-spec.md §9.
 */

import type { CSSProperties, JSX } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

export type GanttStatus = 'planned' | 'running' | 'blocked' | 'done';

export interface GanttTask {
  /** Stable across re-renders — drives diffing / layout continuity. */
  id: string;
  /** The work item, short ("Wire checkout form"). */
  label: string;
  /** Agent / person ("Maya") — rendered as a small tag. */
  owner?: string;
  /** Drives bar color: planned | running | blocked | done. */
  status: GanttStatus;
  /** 0..100 — bar left edge as % of the timeline; default 0. */
  startPct?: number;
  /** 0..100 — bar right edge; default 100 (or startPct if absent). */
  endPct?: number;
  /** Free-text ETA / duration ("~30m", "by 4pm") shown at the bar end. */
  etaLabel?: string;
}

export interface GanttProps {
  /** Card header ("Checkout flow — plan"). */
  title?: string;
  /** The rows, top-to-bottom = order. */
  tasks?: GanttTask[];
  /** 0..100 — position of the "now" marker line; omit to hide. */
  nowPct?: number;
  /** Optional column/lane headers ("Today","Tomorrow") drawn as gridlines. */
  lanes?: string[];
}

/**
 * status → bar fill. Reuses the same `--status-*` tokens AgentPod /
 * AgentRow use so a plan and the Hive read as one system (§9.1):
 *   planned → faint outline (tertiary text token)
 *   running → the active accent (soft neon green)
 *   blocked → amber (gently pulsing)
 *   done    → solid, dimmed
 * Unknown / malformed status degrades to `planned` styling.
 */
const STATUS_FILL: Record<GanttStatus, string> = {
  planned: 'var(--text-tertiary)',
  running: 'var(--status-working)',
  blocked: 'var(--status-blocked)',
  done: 'var(--status-done)',
};

const KNOWN_STATUSES: readonly GanttStatus[] = [
  'planned',
  'running',
  'blocked',
  'done',
];

function normalizeStatus(status: unknown): GanttStatus {
  return KNOWN_STATUSES.includes(status as GanttStatus)
    ? (status as GanttStatus)
    : 'planned';
}

/**
 * Best-effort owner → accent tint. Matches the canonical roster accents
 * (tool-router.ts AGENT_IDENTITY_ROSTER / globals.css `--accent-*`). An
 * unknown owner gets a neutral tag — never an error.
 */
const OWNER_ACCENT: Record<string, string> = {
  maya: 'var(--accent-maya)',
  jin: 'var(--accent-jin)',
  cleo: 'var(--accent-cleo)',
  wren: 'var(--accent-wren)',
};

function ownerAccent(owner: string): string | null {
  return OWNER_ACCENT[owner.trim().toLowerCase()] ?? null;
}

/** Clamp a possibly-undefined/NaN number into [0, 100]. */
function clampPct(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * Resolve a task's bar geometry as { leftPct, widthPct }.
 *
 * - No startPct AND no endPct → full-width row (pure checklist mode).
 * - Otherwise startPct defaults 0, endPct defaults 100, both clamped 0..100.
 * - endPct < startPct is tolerated by rendering a small min-width bar at
 *   startPct (never a negative width) (§9.2 defensive).
 */
function barGeometry(task: GanttTask): { leftPct: number; widthPct: number } {
  const hasStart = typeof task.startPct === 'number' && Number.isFinite(task.startPct);
  const hasEnd = typeof task.endPct === 'number' && Number.isFinite(task.endPct);

  if (!hasStart && !hasEnd) {
    return { leftPct: 0, widthPct: 100 };
  }

  const left = clampPct(task.startPct, 0);
  const right = clampPct(task.endPct, 100);
  // Min-width so a zero/inverted span is still visible as a marker.
  const MIN_WIDTH = 2;
  const width = Math.max(MIN_WIDTH, right - left);
  // Keep the bar inside the track if a clamped min-width pushes past 100.
  const leftPct = Math.min(left, 100 - MIN_WIDTH);
  return { leftPct, widthPct: Math.min(width, 100 - leftPct) };
}

function GanttRow({ task }: { task: GanttTask }): JSX.Element {
  const reduced = useReducedMotion();
  const status = normalizeStatus(task.status);
  const fill = STATUS_FILL[status];
  const planned = status === 'planned';
  const blocked = status === 'blocked';
  const done = status === 'done';

  const { leftPct, widthPct } = barGeometry(task);
  const label = typeof task.label === 'string' ? task.label : '';
  const owner = typeof task.owner === 'string' ? task.owner.trim() : '';
  const eta = typeof task.etaLabel === 'string' ? task.etaLabel.trim() : '';
  const accent = owner ? ownerAccent(owner) : null;

  const rowStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '10px 4px',
  };

  // Bar chrome: planned is a faint *outline* (transparent fill + dashed
  // border); the rest are solid fills. Done dims; blocked pulses.
  const barStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: `${leftPct}%`,
    width: `${widthPct}%`,
    borderRadius: 7,
    background: planned ? 'transparent' : fill,
    border: planned ? `1px dashed ${fill}` : '0.5px solid rgba(255, 255, 255, 0.12)',
    opacity: done ? 0.55 : 1,
    minWidth: 3,
  };

  return (
    <motion.div
      layout
      layoutId={`gantt-${task.id}`}
      transition={
        reduced ? { duration: 0 } : { type: 'spring', stiffness: 180, damping: 24 }
      }
      role="listitem"
      aria-label={`${label || 'Task'}${owner ? `, ${owner}` : ''}, ${status}${
        eta ? `, ${eta}` : ''
      }`}
      data-status={status}
      style={rowStyle}
    >
      {/* Row header: label + optional owner tag */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 13,
            fontWeight: 500,
            color: done ? 'var(--text-secondary)' : 'var(--text-primary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {label}
        </span>
        {owner ? (
          <span
            data-owner={owner}
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
              padding: '2px 7px',
              borderRadius: 999,
              flexShrink: 0,
              color: accent ?? 'var(--text-tertiary)',
              border: `0.5px solid ${accent ?? 'var(--border-subtle)'}`,
              background: accent ? 'rgba(255, 255, 255, 0.04)' : 'transparent',
            }}
          >
            {owner}
          </span>
        ) : null}
      </div>

      {/* Track + positioned bar + ETA at the bar end */}
      <div
        style={{
          position: 'relative',
          height: 14,
          borderRadius: 7,
          background: 'rgba(255, 255, 255, 0.04)',
        }}
      >
        <motion.div
          layout
          aria-hidden
          animate={
            blocked && !reduced ? { opacity: [1, 0.45, 1] } : { opacity: done ? 0.55 : 1 }
          }
          transition={
            blocked && !reduced
              ? { duration: 0.6, repeat: Infinity, ease: 'easeInOut' }
              : { duration: reduced ? 0 : 0.26 }
          }
          style={barStyle}
        />
        {eta ? (
          <span
            style={{
              position: 'absolute',
              top: '50%',
              left: `calc(${Math.min(leftPct + widthPct, 100)}% + 8px)`,
              transform: 'translateY(-50%)',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-tertiary)',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}
          >
            {eta}
          </span>
        ) : null}
      </div>
    </motion.div>
  );
}

/**
 * Lane gridlines + labels overlay. `lanes` are evenly distributed across
 * the track width as faint vertical separators with a top label each.
 * Purely decorative; absolutely positioned so it never affects row layout.
 */
function LaneOverlay({ lanes }: { lanes: string[] }): JSX.Element | null {
  const valid = lanes.filter((l) => typeof l === 'string' && l.length > 0);
  if (valid.length === 0) return null;

  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        pointerEvents: 'none',
      }}
    >
      {valid.map((lane, i) => (
        <div
          key={`${lane}-${i}`}
          style={{
            flex: 1,
            borderLeft: i === 0 ? 'none' : '0.5px solid var(--border-subtle)',
            position: 'relative',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: 6,
              fontFamily: 'var(--font-sans)',
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
              color: 'var(--text-tertiary)',
              opacity: 0.7,
            }}
          >
            {lane}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Thin vertical "now" marker spanning all rows, with a small top cap. */
function NowLine({ nowPct }: { nowPct: number }): JSX.Element {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: `${nowPct}%`,
        width: 0,
        borderLeft: '1.5px solid var(--status-thinking)',
        pointerEvents: 'none',
        zIndex: 2,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: -6,
          left: -3,
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: 'var(--status-thinking)',
          boxShadow: '0 0 6px var(--status-thinking)',
        }}
      />
    </div>
  );
}

export function Gantt({ title, tasks, nowPct, lanes }: GanttProps = {}): JSX.Element {
  const list = Array.isArray(tasks) ? tasks.filter((t) => t && typeof t.id === 'string') : [];
  const laneList = Array.isArray(lanes) ? lanes : [];
  const hasNow = typeof nowPct === 'number' && Number.isFinite(nowPct);
  const clampedNow = hasNow ? clampPct(nowPct, 0) : 0;
  const heading = typeof title === 'string' && title.length > 0 ? title : '';

  return (
    <div
      className="gantt"
      role="group"
      aria-label={heading || 'Plan'}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        height: '100%',
        minHeight: 0,
      }}
    >
      {/* Header chrome — shared canvas eyebrow + title classes */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span className="canvas-eyebrow">Plan</span>
        {heading ? <span className="canvas-title">{heading}</span> : null}
      </div>

      {list.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-tertiary)',
            fontSize: 12,
            letterSpacing: '0.02em',
            textTransform: 'uppercase',
          }}
        >
          Nothing planned yet.
        </div>
      ) : (
        // The track region is position:relative so the lane gridlines and
        // the now-line can overlay every row. The lane/now overlays sit
        // behind/over the rows but only across the bar column area — which
        // here spans the full width (the label sits above its own bar).
        <div
          role="list"
          style={{
            position: 'relative',
            flex: 1,
            overflowY: 'auto',
            minHeight: 0,
            paddingTop: laneList.length > 0 ? 14 : 0,
          }}
        >
          <LaneOverlay lanes={laneList} />
          {hasNow ? <NowLine nowPct={clampedNow} /> : null}
          <div style={{ position: 'relative', zIndex: 1 }}>
            {list.map((task) => (
              <GanttRow key={task.id} task={task} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Alias matching the file name; `Gantt` is the canonical export. */
export const GanttChart = Gantt;
