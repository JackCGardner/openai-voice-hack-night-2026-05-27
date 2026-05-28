import { AnimatePresence } from 'framer-motion';
import type { JSX } from 'react';
import { useAgentsOrderedForHive } from '../state/selectors';
import { useStore } from '../state/store';
import { AgentRow } from './AgentRow';

/**
 * Hive Strip — vertical column of agent rows.
 * Pencil source: design.pen / Strip / Hive Working (v2ONzK).
 *
 * Geometry: 280px wide × 420px tall, 14px radius, padding 16/8.
 * Order:    blocked → working → thinking → spawning → done → error,
 *           dispatch order within group (useAgentsOrderedForHive).
 * Variant:  derived from canonical strip.kind ('escalating' → blocked tint;
 *           all agents done → green-ish tint).
 */
export function HiveStrip(): JSX.Element {
  const agents = useAgentsOrderedForHive();
  const kind = useStore((s) => s.strip.kind);

  const variant: 'working' | 'blocked' | 'done' = (() => {
    if (kind === 'escalating') return 'blocked';
    if (agents.length > 0 && agents.every((a) => a.status === 'done' || a.status === 'killed')) {
      return 'done';
    }
    if (agents.some((a) => a.status === 'blocked' || a.status === 'error')) {
      return 'blocked';
    }
    return 'working';
  })();

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

  const surfaceTint = variant === 'blocked' ? '#100D0AE6' : '#0E0E10E6';

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
          {agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
