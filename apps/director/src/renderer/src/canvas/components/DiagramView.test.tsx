/**
 * Snapshot / behavior tests for DiagramView (spec §2.4). Headless via
 * react-dom/server (node vitest env).
 *
 * The component ships a dependency-free STRUCTURED renderer (parses common
 * mermaid/DOT flows into a source → label → target edge list) with a styled
 * raw-source <pre> fallback for anything it can't parse (see DiagramView.tsx
 * deviation note). These assert: the structured edge view for a multi-edge
 * flow, edge labels, DOT brace bodies, the kind eyebrow, single-edge / opaque
 * source falling back to <pre>, markup escaping, and the empty state.
 */

import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { DiagramView } from './DiagramView';

describe('DiagramView', () => {
  it('renders a multi-edge mermaid flow as a structured edge list', () => {
    const html = renderToString(
      <DiagramView title="Auth flow" kind="mermaid" source={'graph TD; A-->B; B-->C;'} />,
    );
    expect(html).toContain('Mermaid');
    expect(html).toContain('Auth flow');
    // Structured renderer (not the raw <pre>) for ≥2 edges.
    expect(html).toContain('diagram-edges');
    expect(html).toContain('diagram-node');
    expect(html).not.toContain('diagram-view-source');
    // Nodes surfaced.
    expect(html).toContain('>A<');
    expect(html).toContain('>B<');
    expect(html).toContain('>C<');
  });

  it('cleans mermaid node decoration and surfaces inline |labels|', () => {
    const html = renderToString(
      <DiagramView
        kind="mermaid"
        source={'flowchart LR\n  S["Start"] -->|yes| D{Decide}\n  D -->|no| E[End]'}
      />,
    );
    // Decorated nodes render their human label, not the bracket DSL.
    expect(html).toContain('Start');
    expect(html).toContain('Decide');
    expect(html).toContain('End');
    expect(html).not.toContain('S["Start"]');
    // Edge labels surfaced.
    expect(html).toContain('diagram-edge-label');
    expect(html).toContain('yes');
    expect(html).toContain('no');
  });

  it('parses a Graphviz DOT brace body into edges', () => {
    const html = renderToString(
      <DiagramView kind="dot" source={'digraph G { a -> b; b -> c; }'} />,
    );
    expect(html).toContain('Graphviz DOT');
    expect(html).toContain('diagram-edges');
    expect(html).toContain('>a<');
    expect(html).toContain('>b<');
    expect(html).toContain('>c<');
    // The `digraph G {` declaration is lifted to the header (not an edge node).
    expect(html).toContain('diagram-graph-header');
    expect(html).toContain('digraph G');
    expect(html).not.toContain('diagram-node">digraph');
  });

  it('parses a mermaid sequence diagram (: message labels)', () => {
    const html = renderToString(
      <DiagramView
        kind="mermaid"
        source={'sequenceDiagram\n  Client->>Server: request\n  Server-->>Client: response'}
      />,
    );
    expect(html).toContain('diagram-edges');
    expect(html).toContain('Client');
    expect(html).toContain('Server');
    expect(html).toContain('request');
    expect(html).toContain('response');
  });

  it('falls back to a raw source <pre> for a single edge', () => {
    // One edge is just as clear as text; the structured view earns itself at ≥2.
    const html = renderToString(
      <DiagramView kind="dot" source={'digraph { a -> b }'} />,
    );
    expect(html).toContain('Graphviz DOT');
    expect(html).toContain('diagram-view-source');
    expect(html).toContain('digraph');
    expect(html).not.toContain('diagram-edges');
  });

  it('falls back to a raw source <pre> for unparseable source', () => {
    const html = renderToString(
      <DiagramView kind="mermaid" source={'pie title Pets\n  "Dogs": 50\n  "Cats": 50'} />,
    );
    expect(html).toContain('diagram-view-source');
    expect(html).not.toContain('diagram-edges');
  });

  it('escapes diagram source markup in the fallback (rendered as text)', () => {
    const html = renderToString(
      <DiagramView kind="mermaid" source={'graph TD; X["<b>hi</b>"]'} />,
    );
    // Single edge → <pre> fallback; React escapes text children of <pre>.
    expect(html).not.toContain('<b>hi</b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('labels a dot diagram as Graphviz DOT', () => {
    const html = renderToString(
      <DiagramView kind="dot" source={'digraph { a -> b }'} />,
    );
    expect(html).toContain('Graphviz DOT');
    expect(html).toContain('digraph');
  });

  it('falls back to a generic label for an unknown kind', () => {
    const html = renderToString(
      <DiagramView kind="sequence" source={'sequenceDiagram'} />,
    );
    expect(html).toContain('sequence');
  });

  it('renders a calm empty state when source is blank', () => {
    const html = renderToString(<DiagramView kind="mermaid" source="   " />);
    expect(html).toContain('Nothing to diagram yet');
    expect(html).not.toContain('diagram-view-source');
    expect(html).not.toContain('diagram-edges');
  });
});
