/**
 * Snapshot / behavior tests for DiagramView (spec §2.4). Headless via
 * react-dom/server (node vitest env). The component ships the source-fallback
 * renderer (see DiagramView.tsx deviation note), so these assert the labelled
 * <pre> path, the kind eyebrow, and the empty state.
 */

import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { DiagramView } from './DiagramView';

describe('DiagramView', () => {
  it('renders a mermaid source block without crashing', () => {
    const html = renderToString(
      <DiagramView
        title="Auth flow"
        kind="mermaid"
        source={'graph TD; A-->B; B-->C;'}
      />,
    );
    expect(html).toContain('Mermaid');
    expect(html).toContain('Auth flow');
    expect(html).toContain('diagram-view-source');
    expect(html).toContain('graph TD');
  });

  it('labels a dot diagram as Graphviz DOT', () => {
    const html = renderToString(
      <DiagramView kind="dot" source={'digraph { a -> b }'} />,
    );
    expect(html).toContain('Graphviz DOT');
    expect(html).toContain('digraph');
  });

  it('escapes diagram source markup (rendered as text, not HTML)', () => {
    const html = renderToString(
      <DiagramView kind="mermaid" source={'graph TD; X["<b>hi</b>"]'} />,
    );
    // React escapes text children of <pre>, so the literal tag must not leak.
    expect(html).not.toContain('<b>hi</b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('falls back to a generic label for an unknown kind', () => {
    // `kind` widens to string per the prop type, so an unexpected dialect is
    // a valid call — we assert the runtime label falls through to it.
    const html = renderToString(
      <DiagramView kind="sequence" source={'sequenceDiagram'} />,
    );
    expect(html).toContain('sequence');
  });

  it('renders a calm empty state when source is blank', () => {
    const html = renderToString(<DiagramView kind="mermaid" source="   " />);
    expect(html).toContain('Nothing to diagram yet');
    expect(html).not.toContain('diagram-view-source');
  });
});
