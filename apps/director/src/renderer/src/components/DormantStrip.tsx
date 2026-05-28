import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState, type JSX } from 'react';
import { useGoal, useHasActiveWork, useStripKind } from '../state/selectors';
import { useStore } from '../state/store';

/**
 * Dormant Strip — slow waveform breathing pulse + hover-to-peek panel.
 * Pencil source: design.pen / Strip / Dormant (EodJh).
 *
 * Geometry: 12px wide × 180px tall pill, 6px radius.
 * Visual:   vertical linear gradient (transparent → blue mid → transparent),
 *           1.5s sine-eased opacity + scaleY breathing.
 * A11y:     honors prefers-reduced-motion (static mid-tone fill).
 *
 * § dormant-peek (W4 — P5.3):
 *   Mouse-enter while the strip is genuinely dormant (no listening / no
 *   speaking — those mount different components — AND no agents in-flight)
 *   expands a small panel to the LEFT of the pill showing the current goal
 *   and an active-agent count. Mouse-leave waits 800ms before collapsing.
 *   Spec: docs/remaining-phases.md § 5.3.
 *
 * The peek expansion uses Framer's AnimatePresence — no window-resize IPC.
 * The Strip overlay window is already 12px wide; the peek panel paints into
 * its left padding (panels are positioned with right:24px so they grow
 * into transparent window pixels). When the user is in `dormant` AND there
 * is room, the panel reads correctly because the overlay is transparent.
 *
 * If the peek panel needs more horizontal room than the current strip
 * window provides, a future iteration can opt-in to a temporary
 * `window.strip.resize` widening; we intentionally avoid that here to
 * keep this lane main-process-untouching (per W4 P5.3 scope).
 */
const COLLAPSE_DELAY_MS = 800;
const EXPAND_MS = 200;

export function DormantStrip(): JSX.Element {
  const reduced = useReducedMotion();
  const goal = useGoal();
  const hasWork = useHasActiveWork();
  const kind = useStripKind();
  const agentCount = useStore((s) => s.agentOrder.length);
  const [peek, setPeek] = useState(false);
  const collapseTimerRef = useRef<number | null>(null);

  // Suppress peek during listening/speaking — DormantStrip is only mounted
  // in dormant/connecting/error/disconnected, but defend in case parent
  // routing changes upstream.
  const canPeek = kind === 'dormant' && !hasWork;

  // Force-collapse if we ever stop being eligible (e.g. work spawned mid-peek).
  useEffect(() => {
    if (!canPeek && peek) setPeek(false);
  }, [canPeek, peek]);

  const cancelCollapseTimer = (): void => {
    if (collapseTimerRef.current != null) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => cancelCollapseTimer();
  }, []);

  const onEnter = (): void => {
    if (!canPeek) return;
    cancelCollapseTimer();
    setPeek(true);
  };

  const onLeave = (): void => {
    cancelCollapseTimer();
    collapseTimerRef.current = window.setTimeout(() => {
      setPeek(false);
      collapseTimerRef.current = null;
    }, COLLAPSE_DELAY_MS);
  };

  return (
    <div
      className="strip-root"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
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
      <AnimatePresence>
        {peek && canPeek ? (
          <motion.div
            key="dormant-peek"
            className="dormant-peek"
            initial={reduced ? { opacity: 0 } : { opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, x: 8 }}
            transition={{ duration: reduced ? 0.08 : EXPAND_MS / 1000 }}
            aria-hidden
          >
            <span className="dormant-peek-goal">
              {goal ?? 'No goal set'}
            </span>
            <span className="dormant-peek-meta">
              {agentCount === 0
                ? 'No agents'
                : `${agentCount} agent${agentCount === 1 ? '' : 's'}`}
            </span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
