import { motion } from 'framer-motion';
import type { JSX } from 'react';

/**
 * Dormant Strip — slow waveform breathing pulse.
 * Spec (docs/ux-design.md Pass 5 + design.pen / Strip / Dormant):
 *   - 1.5s sine cycle, soft blue tint, gentle glow
 *   - 12 x 180px window (set by main process)
 *   - 6px corner radius (matches design.pen)
 *   - vibrancy 'under-window' (handled by Electron BrowserWindow)
 *
 * The component fills its window edge-to-edge.
 */
export function DormantStrip(): JSX.Element {
  return (
    <div className="strip-root">
      <motion.div
        className="strip-pulse"
        // Sine-like breathing: smooth ease in/out, opacity + scale.
        animate={{
          opacity: [0.35, 0.95, 0.35],
          scaleY: [0.82, 1.0, 0.82],
        }}
        transition={{
          duration: 1.5,
          repeat: Infinity,
          ease: [0.45, 0, 0.55, 1], // approx. sine curve
        }}
      />
    </div>
  );
}
