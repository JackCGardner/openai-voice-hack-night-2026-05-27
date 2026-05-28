import { motion, useReducedMotion } from 'framer-motion';
import type { JSX } from 'react';

/**
 * Dormant Strip — slow waveform breathing pulse.
 * Pencil source: design.pen / Strip / Dormant (EodJh).
 *
 * Geometry: 12px wide × 180px tall pill, 6px radius.
 * Visual: vertical linear gradient (transparent → blue mid → transparent),
 *         1.5s sine-eased opacity + scaleY breathing.
 * A11y:   honors prefers-reduced-motion (static mid-tone fill).
 */
export function DormantStrip(): JSX.Element {
  const reduced = useReducedMotion();

  return (
    <div className="strip-root">
      <div className="strip-small" role="status" aria-label="Director idle">
        <motion.div
          className="strip-pulse"
          animate={
            reduced
              ? { opacity: 0.7, scaleY: 0.95 }
              : { opacity: [0.35, 0.95, 0.35], scaleY: [0.82, 1.0, 0.82] }
          }
          transition={
            reduced
              ? { duration: 0 }
              : { duration: 1.5, repeat: Infinity, ease: [0.45, 0, 0.55, 1] }
          }
        />
      </div>
    </div>
  );
}
