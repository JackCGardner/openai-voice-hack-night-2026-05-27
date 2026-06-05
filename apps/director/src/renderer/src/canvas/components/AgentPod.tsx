/**
 * AgentPod — the live Hive promoted into the Canvas window.
 *
 * Canvas-sized sibling of `HiveStrip` / `AgentRow` (renderer/src/components/).
 * Reuses the same visual language — status disc (fill by `status`, accent
 * ring by `accentColor`), agent name carrying the accent color, italic
 * `currentTask` micro-text, and a mono `recentFiles` breadcrumb (cap 3) —
 * but laid out for the larger Canvas surface (bigger discs, more breathing
 * room, an optional fading task `trail`).
 *
 * Display-only: no `onRespond` / selection. Driven live from the renderer
 * store via the canvas relay (docs/voice-genui-spec.md §3.2): the strip
 * renderer re-relays `canvas.render('agent_pod', { agents })` on each agents
 * slice change, so this re-renders on every tick from fresh props.
 *
 * Polish (BUILD wave): a Hive header with a live "N working" summary and a
 * compact status legend so the big surface reads as a dashboard, not a list.
 * The per-node layout is unchanged in spirit (AgentRow parity) but tightened.
 *
 * Spec: docs/voice-genui-spec.md §2.5 / §6.5.
 */

import type { CSSProperties, JSX } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

export type AgentPodStatus =
  | 'spawning'
  | 'working'
  | 'blocked'
  | 'thinking'
  | 'done'
  | 'error'
  | 'killed';

export interface AgentPodAgent {
  id: string;
  name: string;
  role: string;
  /** Hex color literal, e.g. '#7AC0FF'. Forms the accent ring. */
  accentColor: string;
  status: AgentPodStatus;
  currentTask: string | null;
  recentFiles: string[];
  /** Optional task micro-text history (the store's `taskTrail`). */
  trail?: string[];
}

export interface AgentPodProps {
  agents: AgentPodAgent[];
}

/**
 * Status → disc fill. Matches `AgentRow.STATUS_FILL` (the Hive-strip sibling)
 * so the Canvas pod reads identically to the strip. Unknown / malformed
 * statuses fall back to the tertiary text token rather than throwing.
 */
const STATUS_FILL: Record<AgentPodStatus, string> = {
  working: 'var(--status-working)',
  blocked: 'var(--status-blocked)',
  done: 'var(--status-done)',
  thinking: 'var(--status-thinking)',
  spawning: 'var(--text-tertiary)',
  error: 'var(--status-error)',
  killed: 'var(--text-tertiary)',
};

function statusFill(status: string): string {
  return STATUS_FILL[status as AgentPodStatus] ?? 'var(--text-tertiary)';
}

/** Active = the model is still doing something we'd narrate as "in flight". */
const ACTIVE_STATUSES = new Set<AgentPodStatus>([
  'working',
  'thinking',
  'spawning',
]);

function AgentPodNode({ agent }: { agent: AgentPodAgent }): JSX.Element {
  const reduced = useReducedMotion();
  const fill = statusFill(agent.status);
  const pulsing = agent.status === 'blocked' || agent.status === 'error';
  const dim = agent.status === 'done' || agent.status === 'killed';

  // Headline mirrors AgentRow: prefer currentTask, else the latest trail entry.
  const trail = Array.isArray(agent.trail) ? agent.trail : [];
  const headline = agent.currentTask ?? trail[trail.length - 1] ?? '';
  const files = Array.isArray(agent.recentFiles)
    ? agent.recentFiles.slice(-3).join(' · ')
    : '';
  // Older trail entries (excluding the one shown as the headline) fade out.
  const fadingTrail =
    headline === trail[trail.length - 1]
      ? trail.slice(0, -1).slice(-2)
      : trail.slice(-2);

  const nodeStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '14px 16px',
    borderRadius: 14,
    border: '0.5px solid var(--border-subtle)',
    background: 'rgba(20, 20, 22, 0.6)',
    opacity: dim ? 0.62 : 1,
    // A hairline accent edge ties the node to its agent without a heavy block.
    boxShadow: `inset 2px 0 0 0 ${agent.accentColor}`,
  };

  return (
    <motion.div
      layout
      layoutId={agent.id}
      transition={
        reduced ? { duration: 0 } : { type: 'spring', stiffness: 180, damping: 22 }
      }
      role="status"
      aria-label={`${agent.name}, ${String(agent.role).toLowerCase()}, ${
        agent.status
      }${headline ? `, ${headline}` : ''}`}
      style={nodeStyle}
    >
      {/* Header: accent-ringed status disc · name · spacer · role tag */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}
      >
        <motion.span
          aria-hidden
          animate={pulsing && !reduced ? { opacity: [1, 0.45, 1] } : { opacity: 1 }}
          transition={
            pulsing && !reduced
              ? { duration: 0.6, repeat: Infinity, ease: 'easeInOut' }
              : { duration: 0 }
          }
          style={{
            display: 'inline-block',
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: fill,
            // Accent ring (per-agent color) around the status fill.
            boxShadow: `0 0 0 2px ${agent.accentColor}`,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 16,
            fontWeight: 600,
            color: agent.accentColor,
            letterSpacing: -0.1,
          }}
        >
          {agent.name}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 11,
            fontWeight: 500,
            color: 'var(--text-tertiary)',
            letterSpacing: 0.5,
          }}
        >
          {String(agent.role).toUpperCase()}
        </span>
      </div>

      {/* Current task (italic, indented to align past the disc) */}
      {headline ? (
        <div style={{ paddingLeft: 26 }}>
          <span
            style={{
              fontFamily: 'var(--font-sans)',
              fontStyle: 'italic',
              fontSize: 13,
              fontWeight: 400,
              color: pulsing ? 'var(--status-blocked)' : 'var(--text-secondary)',
            }}
          >
            {headline}
          </span>
        </div>
      ) : null}

      {/* Fading task trail — older micro-text, progressively dimmer. */}
      {fadingTrail.length > 0 ? (
        <div
          style={{
            paddingLeft: 26,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
        >
          {fadingTrail.map((entry, i) => (
            <span
              key={`${entry}-${i}`}
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 11,
                color: 'var(--text-tertiary)',
                // Earliest entry faintest.
                opacity: 0.35 + (i / Math.max(fadingTrail.length, 1)) * 0.3,
              }}
            >
              {entry}
            </span>
          ))}
        </div>
      ) : null}

      {/* Files breadcrumb (mono, cap 3) */}
      {files ? (
        <div style={{ paddingLeft: 26 }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              fontWeight: 400,
              color: 'var(--text-tertiary)',
            }}
          >
            {files}
          </span>
        </div>
      ) : null}
    </motion.div>
  );
}

/** One swatch in the header legend (a status dot + count). */
function LegendItem({
  fill,
  count,
  label,
}: {
  fill: string;
  count: number;
  label: string;
}): JSX.Element {
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
      title={`${count} ${label}`}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: fill,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 11,
          color: 'var(--text-tertiary)',
          letterSpacing: 0.2,
        }}
      >
        {count}
      </span>
    </span>
  );
}

export function AgentPod({ agents }: AgentPodProps): JSX.Element {
  const list = Array.isArray(agents) ? agents : [];

  const active = list.filter((a) => ACTIVE_STATUSES.has(a.status)).length;
  const blocked = list.filter(
    (a) => a.status === 'blocked' || a.status === 'error',
  ).length;
  const done = list.filter(
    (a) => a.status === 'done' || a.status === 'killed',
  ).length;
  // Summary headline: lead with the most actionable state.
  const summary =
    blocked > 0
      ? `${blocked} blocked · ${active} working`
      : active > 0
        ? `${active} working`
        : done > 0
          ? `${done} done`
          : `${list.length} ${list.length === 1 ? 'agent' : 'agents'}`;

  return (
    <div
      className="agent-pod"
      role="group"
      aria-label="Agent hive"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        height: '100%',
        minHeight: 0,
      }}
    >
      {/* Hive header — eyebrow + live summary + status legend. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 12,
          flexShrink: 0,
        }}
      >
        <span className="canvas-eyebrow">Hive</span>
        <span
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--text-secondary)',
          }}
        >
          {summary}
        </span>
        <span style={{ flex: 1 }} />
        {list.length > 0 ? (
          <span style={{ display: 'inline-flex', gap: 12 }}>
            {active > 0 ? (
              <LegendItem
                fill="var(--status-working)"
                count={active}
                label="working"
              />
            ) : null}
            {blocked > 0 ? (
              <LegendItem
                fill="var(--status-blocked)"
                count={blocked}
                label="blocked"
              />
            ) : null}
            {done > 0 ? (
              <LegendItem fill="var(--status-done)" count={done} label="done" />
            ) : null}
          </span>
        ) : null}
      </div>

      {/* Agent column (scrolls). */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          flex: 1,
          overflowY: 'auto',
          minHeight: 0,
        }}
      >
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
            No agents running
          </div>
        ) : (
          list.map((agent) => <AgentPodNode key={agent.id} agent={agent} />)
        )}
      </div>
    </div>
  );
}
