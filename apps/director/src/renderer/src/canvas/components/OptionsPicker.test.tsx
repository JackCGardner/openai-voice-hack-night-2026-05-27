/**
 * OptionsPicker — render snapshot / behavior tests. The vitest config runs
 * under the `node` environment (no jsdom), so we render via
 * `react-dom/server.renderToString` and assert on the HTML payload (same
 * approach as canvas-degrade.test.tsx).
 *
 * Covers docs/voice-genui-spec.md §2.1:
 * - renders title + question + each option's label/detail without crashing
 * - exposes the option as a selectable button (role="option")
 * - echoes sessionId into a data attribute (correlation token)
 * - tolerates a missing/empty options list (calm empty state, no throw)
 */

import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { OptionsPicker } from './OptionsPicker';

describe('OptionsPicker', () => {
  it('renders title, question, and option cards with labels + details', () => {
    const html = renderToString(
      <OptionsPicker
        title="Pick an approach"
        question="How should we split the API?"
        options={[
          { id: 'by-resource', label: 'By resource', detail: 'Two files' },
          { id: 'by-verb', label: 'By verb', detail: 'One router' },
        ]}
      />,
    );
    expect(html).toContain('Pick an approach');
    expect(html).toContain('How should we split the API?');
    expect(html).toContain('By resource');
    expect(html).toContain('Two files');
    expect(html).toContain('By verb');
    expect(html).toContain('One router');
    // Each option is a selectable listbox option.
    expect(html).toMatch(/role="option"/);
  });

  it('echoes sessionId into a data attribute for strip correlation', () => {
    const html = renderToString(
      <OptionsPicker
        question="Resume?"
        sessionId="sess-abc123"
        options={[{ id: 'yes', label: 'Resume' }]}
      />,
    );
    expect(html).toContain('sess-abc123');
  });

  it('omits the detail line when an option has no detail', () => {
    const html = renderToString(
      <OptionsPicker
        question="Yes or no?"
        options={[{ id: 'yes', label: 'Yes' }]}
      />,
    );
    expect(html).toContain('Yes');
    expect(html).not.toContain('options-picker-detail');
  });

  it('renders a calm empty state when options are missing', () => {
    const html = renderToString(
      <OptionsPicker
        question="Nothing here"
        // @ts-expect-error — exercise the runtime guard for a bad options value
        options={undefined}
      />,
    );
    expect(html).toContain('No options to choose from.');
    expect(html).not.toMatch(/role="option"/);
  });
});
