/**
 * Snapshot / behavior tests for the de-demo'd ArtifactPreview
 * (docs/voice-genui-spec.md §2.6). The load-bearing assertions:
 *
 * - With NO src/html/mixtape, it shows a calm empty state and contains NONE
 *   of the old Tokyo-neon Mixtape fixture strings (the "showed me the demo
 *   mixtape when I asked about my real project" bug).
 * - It renders strictly from arbitrary props (title/notes/iframe/image/html).
 * - The explicit `mixtape` demo prop still renders the flip-card chrome.
 *
 * Rendered via `react-dom/server.renderToString` (node env, no jsdom) per
 * canvas-degrade.test.tsx.
 */

import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ArtifactPreview } from './ArtifactPreview';

// Fragments from the deleted MOCK_MIXTAPE fixture — must never appear unless
// a caller explicitly passes that content.
const DEMO_LEAK_STRINGS = [
  'Midnight Driver',
  'Akira Vance',
  'Tokyo neon',
  'late-night drive',
  'CHROMERIDER',
  'Akihabara Sunrise',
];

describe('ArtifactPreview — empty props (de-demo)', () => {
  it('renders the calm empty state with no props', () => {
    const html = renderToString(<ArtifactPreview />);
    expect(html).toContain('Nothing to preview yet');
  });

  it('leaks NONE of the old Mixtape demo strings on empty props', () => {
    const html = renderToString(<ArtifactPreview />);
    for (const leak of DEMO_LEAK_STRINGS) {
      expect(html).not.toContain(leak);
    }
  });

  it('does not point an iframe at localhost:3001', () => {
    const html = renderToString(<ArtifactPreview title="My Project" />);
    expect(html).not.toContain('localhost:3001');
  });

  it('shows empty state (not demo data) when a partial artifact omits src', () => {
    // kind: 'iframe' with no src must NOT silently render demo tracks.
    const html = renderToString(<ArtifactPreview kind="iframe" />);
    expect(html).toContain('Nothing to preview yet');
    for (const leak of DEMO_LEAK_STRINGS) {
      expect(html).not.toContain(leak);
    }
  });
});

describe('ArtifactPreview — arbitrary props', () => {
  it('renders a title + notes', () => {
    const html = renderToString(
      <ArtifactPreview title="Landing hero" notes="v3, dark variant" />,
    );
    expect(html).toContain('Landing hero');
    expect(html).toContain('v3, dark variant');
  });

  it('renders an iframe for kind=iframe with a real src', () => {
    const html = renderToString(
      <ArtifactPreview kind="iframe" src="https://example.com/preview" />,
    );
    expect(html).toContain('iframe');
    expect(html).toContain('https://example.com/preview');
    expect(html).not.toContain('Nothing to preview yet');
  });

  it('renders sandboxed HTML for kind=html (no scripts)', () => {
    const html = renderToString(
      <ArtifactPreview kind="html" html="<h1>Hello</h1>" />,
    );
    // srcDoc is iframe-isolated; sandbox attr present, allow-scripts absent.
    expect(html).toContain('sandbox=""');
    expect(html).not.toContain('allow-scripts');
  });

  it('renders Ship/Iterate/Discard only when onAction is wired', () => {
    const withHandler = renderToString(
      <ArtifactPreview title="x" onAction={() => {}} />,
    );
    expect(withHandler).toMatch(/Ship/);
    expect(withHandler).toMatch(/Iterate/);
    expect(withHandler).toMatch(/Discard/);

    const displayOnly = renderToString(<ArtifactPreview title="x" />);
    expect(displayOnly).not.toMatch(/>Ship</);
  });
});

describe('ArtifactPreview — explicit mixtape demo still works', () => {
  it('renders the flip-card chrome when a mixtape is passed', () => {
    const html = renderToString(
      <ArtifactPreview
        title="Mixtape"
        notes="Tokyo Neon · 6 tracks"
        mixtape={{
          vibe: 'late-night drive through Tokyo neon',
          coverUrl: '',
          tracks: [
            { title: 'Midnight Driver', artist: 'Akira Vance', runtime: '4:12' },
          ],
        }}
      />,
    );
    // The demo content renders ONLY because it was explicitly passed.
    expect(html).toContain('Midnight Driver');
    expect(html).toContain('Akira Vance');
    expect(html).toContain('Mixtape');
    expect(html).not.toContain('Nothing to preview yet');
  });
});
