/**
 * HtmlView — render snapshot / security tests. The vitest config runs under
 * the `node` environment (no jsdom), so we render via
 * `react-dom/server.renderToString` and assert on the HTML payload.
 *
 * Covers docs/voice-genui-spec.md §2.2:
 * - renders the optional title header
 * - renders an iframe carrying the model HTML via srcDoc (NOT inlined)
 * - FIXED security rule: the iframe is fully sandboxed (`sandbox=""`),
 *   with NO `allow-scripts` and NO `allow-same-origin`
 * - tolerates a missing/empty html field (calm empty state, no throw)
 */

import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { HtmlView } from './HtmlView';

describe('HtmlView', () => {
  it('renders title + an iframe carrying the html via srcDoc', () => {
    const html = renderToString(
      <HtmlView title="Report" html="<h1>Hello</h1><p>Body</p>" />,
    );
    expect(html).toContain('Report');
    expect(html).toContain('<iframe');
    // The markup is delivered via srcDoc (React serializes it as srcdoc),
    // with the angle brackets HTML-escaped inside the attribute.
    expect(html.toLowerCase()).toContain('srcdoc=');
    expect(html).toContain('Hello');
  });

  it('fully sandboxes the iframe — no scripts, no same-origin', () => {
    const html = renderToString(<HtmlView html="<b>x</b>" />);
    // Empty sandbox attribute = maximally restricted.
    expect(html).toMatch(/sandbox=""/);
    expect(html).not.toContain('allow-scripts');
    expect(html).not.toContain('allow-same-origin');
  });

  it('renders a calm empty state when html is missing', () => {
    const html = renderToString(
      // @ts-expect-error — exercise the runtime guard for a missing html value
      <HtmlView />,
    );
    expect(html).toContain('Nothing to render.');
    expect(html).not.toContain('<iframe');
  });

  it('renders a calm empty state for an empty/whitespace html string', () => {
    const html = renderToString(<HtmlView html="   " />);
    expect(html).toContain('Nothing to render.');
    expect(html).not.toContain('<iframe');
  });
});
