/**
 * DiagramView — renders a diagram description (`source`) for the Canvas.
 * Display-only (no `onRespond`). Spec: docs/voice-genui-spec.md §2.4
 * (`diagram`). The FIXED prop shape is `{ title?, kind, source }` where
 * `kind` discriminates 'mermaid' | 'dot'.
 *
 * RENDERER CHOICE / DEVIATION (see report): the spec permits either a real
 * renderer (mermaid.js for 'mermaid', Graphviz/@viz-js for 'dot') OR a
 * styled `<pre>` fallback "if the dep is too heavy", and says to never throw.
 * The project ships neither `mermaid` nor `@viz-js/viz` today; both are heavy
 * (mermaid pulls d3 + ~hundreds of KB into the canvas bundle). For this build
 * wave we ship the SOURCE FALLBACK: a labelled, monospaced, dark-frosted
 * panel showing the raw `source`. The component is structured so a real
 * renderer can be dropped into `renderDiagram()` later (see the TODO) without
 * touching the public props or the CanvasApp wiring.
 *
 * Defensive: tolerates a missing/blank `source` (calm empty state) and an
 * unknown `kind` (renders as a generic source block, never throws).
 */

import { type JSX } from 'react';

export interface DiagramViewProps {
  /** Optional card header. */
  title?: string;
  /** Diagram dialect. Drives the eyebrow label + (future) renderer choice. */
  kind?: 'mermaid' | 'dot' | string;
  /** The diagram source text (mermaid graph DSL or Graphviz DOT). */
  source?: string;
}

/** Human label for the diagram dialect shown in the header eyebrow. */
function kindLabel(kind: DiagramViewProps['kind']): string {
  if (kind === 'mermaid') return 'Mermaid';
  if (kind === 'dot') return 'Graphviz DOT';
  return typeof kind === 'string' && kind.length > 0 ? kind : 'Diagram';
}

export function DiagramView({
  title,
  kind,
  source,
}: DiagramViewProps = {}): JSX.Element {
  const src = typeof source === 'string' ? source : '';
  const hasSource = src.trim().length > 0;
  const label = kindLabel(kind);

  return (
    <div className="diagram-view">
      <div className="diagram-view-head">
        <span className="canvas-eyebrow">{label}</span>
        {typeof title === 'string' && title.length > 0 ? (
          <span className="canvas-title">{title}</span>
        ) : null}
      </div>

      {hasSource ? (
        // TODO(diagram-render): swap this fallback for a real renderer
        // (mermaid.js for kind==='mermaid', @viz-js/viz for kind==='dot')
        // once we accept the bundle cost. Keep the <pre> path as the
        // catch-on-render-failure fallback per spec §2.4 (never throw).
        <div className="diagram-view-scroll" data-no-drag>
          <pre className="diagram-view-source">{src}</pre>
        </div>
      ) : (
        <div className="diagram-view-empty">Nothing to diagram yet.</div>
      )}
    </div>
  );
}
