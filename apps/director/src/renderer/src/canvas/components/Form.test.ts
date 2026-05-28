/**
 * Form — basic render snapshot. Headless: serializes the component via
 * ReactDOMServer.renderToStaticMarkup so no DOM is required (matches the
 * project's node-environment vitest config).
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { Form } from './Form.js';

describe('Form', () => {
  it('renders the default onboarding triplet without crashing', () => {
    const markup = renderToStaticMarkup(
      createElement(Form, { title: 'Project setup' }),
    );
    expect(markup).toContain('Project setup');
    expect(markup).toContain('Project path');
    expect(markup).toContain('Voice');
    expect(markup).toContain('OpenAI API key');
    // The submit button must exist + be disabled while required fields are empty.
    expect(markup).toMatch(/<button[^>]*disabled/);
  });

  it('accepts a custom field list and submit label', () => {
    const markup = renderToStaticMarkup(
      createElement(Form, {
        title: 'Quick start',
        submitLabel: 'Begin',
        fields: [
          { id: 'name', label: 'Your name', kind: 'text' },
        ],
      }),
    );
    expect(markup).toContain('Your name');
    expect(markup).toContain('Begin');
  });
});
