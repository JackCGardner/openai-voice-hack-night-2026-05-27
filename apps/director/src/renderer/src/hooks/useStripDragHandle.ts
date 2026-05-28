/**
 * useStripDragHandle — toggles the Strip into a Canvas-window drag handle
 * while the Canvas is open.
 *
 * When canvas.open === true:
 *   - Sets `data-strip-drag="on"` on <html> so globals.css can switch the
 *     cursor to `grab` over the Strip surface.
 *   - The Strip overlay window inherits `-webkit-app-region: drag` on html
 *     already, so the user can drag the Strip window itself; the Canvas
 *     window follows via `main/canvas.ts` `setStripWindow` reposition.
 *
 * Spec: docs/remaining-phases.md § 5.3 ("Strip-as-Canvas-handle").
 *
 * Note: the Strip BrowserWindow is currently created with `movable: false`
 * (apps/director/src/main/index.ts). Until W3/Main flips that to `true`
 * while the canvas is open, this hook is the visual half — the cursor
 * affordance is correct and the wiring is in place for the moment the
 * underlying window becomes movable. We deliberately do NOT touch main in
 * this lane.
 */

import { useEffect } from 'react';
import { useIsCanvasOpen } from '../state/selectors.js';

export function useStripDragHandle(): void {
  const canvasOpen = useIsCanvasOpen();
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    if (canvasOpen) {
      html.dataset.stripDrag = 'on';
    } else {
      delete html.dataset.stripDrag;
    }
    return () => {
      delete html.dataset.stripDrag;
    };
  }, [canvasOpen]);
}
