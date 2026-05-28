import { motion, useReducedMotion } from 'framer-motion';
import type { JSX } from 'react';
import { useDirectorStore } from '../state/store';

/**
 * Thinking Strip — gpt-5.5 deep reasoning.
 * Pencil source: design.pen / Strip / Thinking (TiVyu).
 *
 * Geometry: 38px wide × 180px tall, 14px radius. Strip sits on right edge;
 *           reasoning trail fades upward to its left.
 * Visual:   PulseCore radial gradient (status-thinking blue), slow 2.4s
 *           breathing. Trail lines fade with age — newest brightest.
 */
export function ThinkingStrip(): JSX.Element {
  const reduced = useReducedMotion();
  const trail = useDirectorStore((s) => s.thinkingTrail);
  // Newest line at bottom of array → render bottom-up.
  const lines = trail.slice(-4);

  return (
    <div
      className="strip-root"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 12,
        padding: '0 8px 0 16px',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          alignItems: 'flex-end',
          maxWidth: 220,
          textAlign: 'right',
        }}
        aria-hidden
      >
        {lines.map((line, idx) => {
          const recency = (idx + 1) / lines.length; // 0 → faded, 1 → fresh
          return (
            <span
              key={`${idx}-${line}`}
              style={{
                fontFamily: 'var(--font-sans)',
                fontStyle: 'italic',
                fontSize: 12,
                fontWeight: 400,
                color: 'var(--text-secondary)',
                opacity: 0.25 + recency * 0.7,
                lineHeight: 1.35,
              }}
            >
              {line}
            </span>
          );
        })}
      </div>

      <div
        role="status"
        aria-label="Director thinking"
        style={{
          position: 'relative',
          width: 38,
          height: 180,
          borderRadius: 14,
          border: '0.5px solid rgba(110, 148, 232, 0.25)',
          background: '#0E0E10D9',
          boxShadow: 'var(--shadow-thinking), var(--shadow-strip)',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <motion.div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: 22,
            height: 22,
            marginLeft: -11,
            marginTop: -11,
            borderRadius: '50%',
            background:
              'radial-gradient(circle, rgba(110,148,232,1) 0%, rgba(110,148,232,0) 70%)',
            willChange: 'transform, opacity',
          }}
          animate={
            reduced
              ? { scale: 1, opacity: 0.85 }
              : { scale: [0.85, 1.15, 0.85], opacity: [0.6, 1, 0.6] }
          }
          transition={
            reduced
              ? { duration: 0 }
              : { duration: 2.4, repeat: Infinity, ease: [0.45, 0, 0.55, 1] }
          }
        />
      </div>
    </div>
  );
}
