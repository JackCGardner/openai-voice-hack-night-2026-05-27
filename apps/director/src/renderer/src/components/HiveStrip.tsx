import { AnimatePresence } from 'framer-motion';
import type { JSX } from 'react';
import { useDirectorStore, type Agent } from '../state/store';
import { AgentRow } from './AgentRow';

const STATUS_RANK: Record<Agent['status'], number> = {
  blocked: 0,
  working: 1,
  idle: 2,
  done: 3,
};

interface HiveStripProps {
  /** Override store agents (used by dev switcher to demo Blocked / Done states). */
  agents?: Agent[];
  /** Border tint — amber on blocked variant, green on done. */
  variant?: 'working' | 'blocked' | 'done';
}

/**
 * Hive Strip — vertical column of agent rows.
 * Pencil source: design.pen / Strip / Hive Working (v2ONzK).
 *
 * Geometry: 280px wide × 420px tall, 14px radius, padding 16/8.
 * Order:    blocked → working → idle → done, dispatch order within group.
 * Reorder:  Framer Motion layout prop springs rows into place.
 */
export function HiveStrip({ agents: agentsProp, variant = 'working' }: HiveStripProps): JSX.Element {
  const storeAgents = useDirectorStore((s) => s.agents);
  const agents = agentsProp ?? storeAgents;

  const sorted = [...agents].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);

  const borderColor =
    variant === 'blocked'
      ? 'rgba(232, 169, 92, 0.40)'
      : variant === 'done'
        ? 'rgba(88, 214, 141, 0.25)'
        : 'rgba(255, 255, 255, 0.12)';

  const glow =
    variant === 'blocked'
      ? 'var(--shadow-blocked)'
      : variant === 'done'
        ? '0 0 32px rgba(88, 214, 141, 0.18)'
        : 'none';

  const surfaceTint =
    variant === 'blocked' ? '#100D0AE6' : '#0E0E10E6';

  return (
    <div className="strip-root">
      <div
        role="group"
        aria-label="Agent hive"
        style={{
          width: 280,
          height: 420,
          borderRadius: 14,
          border: `0.5px solid ${borderColor}`,
          background: surfaceTint,
          padding: '16px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          boxShadow: `${glow}, var(--shadow-strip)`,
          overflow: 'hidden',
        }}
      >
        <AnimatePresence initial={false}>
          {sorted.map((agent) => (
            <AgentRow key={agent.id} agent={agent} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
