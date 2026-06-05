/**
 * Snapshot / behavior tests for CodePreview (spec §2.3). Headless: rendered
 * via react-dom/server (the vitest config runs the `node` environment, no
 * jsdom), asserting on the serialized HTML.
 *
 * Covers: renders with sample props without crashing; header prefers `path`
 * over `title`; language label renders; line-number gutter is produced;
 * highlighting wraps tokens; HTML in the source is escaped (no injection);
 * empty/missing code yields the calm empty state.
 */

import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { CodePreview } from './CodePreview';

describe('CodePreview', () => {
  it('renders sample TS code without crashing', () => {
    const html = renderToString(
      <CodePreview
        title="snippet"
        path="src/main/foo.ts"
        language="ts"
        code={'const x = 1;\nfunction y() { return x; }'}
      />,
    );
    // header prefers path over title
    expect(html).toContain('src/main/foo.ts');
    expect(html).not.toContain('>snippet<');
    // language label (lowercased)
    expect(html).toContain('ts');
    // line-number gutter present for both lines
    expect(html).toContain('code-preview-ln');
    expect(html).toContain('>1<');
    expect(html).toContain('>2<');
    // keyword + string highlighting spans emitted
    expect(html).toContain('cp-keyword');
    expect(html).toContain('cp-number');
  });

  it('falls back to title when no path is given', () => {
    const html = renderToString(
      <CodePreview title="just a title" code={'echo hi'} />,
    );
    expect(html).toContain('just a title');
  });

  it('escapes HTML in the source (no raw injection)', () => {
    const html = renderToString(
      <CodePreview code={'<script>alert(1)</script>'} language="html" />,
    );
    // The literal <script> tag must not appear unescaped in the output.
    expect(html).not.toContain('<script>alert(1)</script>');
    // It must appear escaped instead.
    expect(html).toContain('&lt;script&gt;');
  });

  it('highlights line comments', () => {
    const html = renderToString(
      <CodePreview code={'// a comment\nconst z = 2;'} language="js" />,
    );
    expect(html).toContain('cp-comment');
  });

  it('renders a calm empty state when code is missing', () => {
    const html = renderToString(<CodePreview />);
    expect(html).toContain('No code to preview yet');
    expect(html).not.toContain('code-preview-ln');
    // No copy affordance when there's nothing to copy.
    expect(html).not.toContain('code-preview-copy');
  });

  it('colors value literals (true/null) distinctly from keywords', () => {
    const html = renderToString(
      <CodePreview code={'const ok = true;\nconst x = null;'} language="ts" />,
    );
    expect(html).toContain('cp-literal');
    // `true` is a literal, not a control keyword.
    expect(html).toMatch(/cp-literal">true/);
  });

  it('colors JSX/HTML tags as markup (escaped, never injected)', () => {
    const html = renderToString(
      <CodePreview code={'<div className="x">hi</div>'} language="tsx" />,
    );
    // The tag run is wrapped in the tag token class…
    expect(html).toContain('cp-tag');
    // …and the literal angle brackets never leak unescaped.
    expect(html).not.toContain('<div className="x">');
    expect(html).toContain('&lt;div');
  });

  it('exposes a copy affordance when code is present', () => {
    const html = renderToString(<CodePreview code={'echo hi'} />);
    expect(html).toContain('code-preview-copy');
    expect(html).toContain('Copy');
  });

  it('scales the gutter for 3-digit line counts without crashing', () => {
    const code = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n');
    const html = renderToString(<CodePreview code={code} />);
    // Last line number rendered…
    expect(html).toContain('>120<');
    // …and the gutter var widened past the 2ch default (3 digits + 1).
    expect(html).toContain('--cp-gutter:4ch');
  });
});
