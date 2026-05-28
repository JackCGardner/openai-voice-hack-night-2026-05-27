import { motion } from 'framer-motion';
import type { JSX } from 'react';
import type { Agent } from '../../../shared/state';

const STATUS_FILL: Record<Agent['status'], string> = {
  working: 'var(--status-working)',
  blocked: 'var(--status-blocked)',
  done: 'var(--status-done)',
  thinking: 'var(--status-thinking)',
  spawning: 'var(--text-tertiary)',
  error: 'var(--status-error)',
  killed: 'var(--text-tertiary)',
};

interface AgentRowProps {
  agent: Agent;
}

/**
 * AgentRow — one horizontal row inside the Hive Strip.
 * Pencil source: design.pen / AgentRow (gFDBG).
 *
 * Anti-slop notes (Pass 4): no cards, no progress bars. Status lives only
 * in the left disc; the name carries the agent's accent color. Blocked
 * rows pulse at 0.6s (--pulse-blocked).
 */
export function AgentRow({ agent }: AgentRowProps): JSX.Element {
  const statusFill = STATUS_FILL[agent.status];
  const dim = agent.status === 'done' || agent.status === 'killed';
  const headline = agent.currentTask ?? agent.taskTrail[agent.taskTrail.length - 1] ?? '';
  const files = agent.recentFiles.slice(-3).join(' · ');

  return (
    <motion.div
      layout
      layoutId={agent.id}
      transition={{ type: 'spring', stiffness: 180, damping: 22 }}
      role="status"
      aria-label={`${agent.name}, ${String(agent.role).toLowerCase()}, ${agent.status}, ${headline}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '10px 12px',
        opacity: dim ? 0.7 : 1,
      }}
    >
      {/* Header: disc · name · spacer · role tag */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
        }}
      >
        <motion.span
          aria-hidden
          animate={
            agent.status === 'blocked' || agent.status === 'error'
              ? { opacity: [1, 0.45, 1] }
              : { opacity: 1 }
          }
          transition={
            agent.status === 'blocked' || agent.status === 'error'
              ? { duration: 0.6, repeat: Infinity, ease: 'easeInOut' }
              : { duration: 0 }
          }
          style={{
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: statusFill,
            boxShadow: `0 0 0 1.5px ${statusFill}`,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 14,
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

      {/* Trail row (italic, indented to align with name baseline) */}
      {headline ? (
        <div style={{ paddingLeft: 20 }}>
          <span
            style={{
              fontFamily: 'var(--font-sans)',
              fontStyle: 'italic',
              fontSize: 12,
              fontWeight: 400,
              color:
                agent.status === 'blocked' || agent.status === 'error'
                  ? 'var(--status-blocked)'
                  : 'var(--text-secondary)',
            }}
          >
            {agent.status === 'blocked' && agent.blocker ? agent.blocker : headline}
          </span>
        </div>
      ) : null}

      {/* Files breadcrumb (mono, half-step smaller) */}
      {files ? (
        <div style={{ paddingLeft: 20 }}>
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
