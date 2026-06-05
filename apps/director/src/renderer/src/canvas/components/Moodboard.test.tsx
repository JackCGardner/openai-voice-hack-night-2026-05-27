/**
 * Snapshot / behavior tests for Moodboard (docs/voice-genui-spec.md §2 / §6.6 /
 * §10). Rendered via `react-dom/server.renderToString` under the vitest `node`
 * environment (no jsdom), matching AgentPod.test.tsx.
 *
 * Covers the two §10 cases explicitly: concepts WITH generated image URLs
 * (file:// / data: / https — each renders as a background-image cover) and
 * concepts WITHOUT an image (graceful per-tile placeholder, no broken image),
 * plus the zero-concepts empty state and optional palette swatches.
 */

import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Moodboard, type MoodboardConcept } from './Moodboard';

const WITH_IMAGES: MoodboardConcept[] = [
  {
    id: 'c1',
    label: 'Neon Brutalist',
    description: 'High-contrast slabs, electric accents',
    // file:// path to a brain-saved generated image (~/.director/generated).
    image_url: 'file:///Users/x/.director/generated/1717-neon.png',
    palette: ['#0A0A0A', '#39FF14', '#FF00A0'],
  },
  {
    id: 'c2',
    label: 'Soft Editorial',
    description: 'Serif headers, generous whitespace',
    // inline data-URL generated image.
    image_url:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  },
  {
    id: 'c3',
    label: 'Retro Terminal',
    description: 'Mono type, scanlines, amber on black',
    image_url: 'https://example.com/concepts/retro.png',
  },
];

describe('Moodboard — concepts with generated images', () => {
  it('renders every concept label + description without crashing', () => {
    const html = renderToString(
      <Moodboard title="Pick a direction" concepts={WITH_IMAGES} />,
    );
    expect(html).toContain('Pick a direction');
    expect(html).toContain('Neon Brutalist');
    expect(html).toContain('Soft Editorial');
    expect(html).toContain('Retro Terminal');
    expect(html).toContain('Serif headers, generous whitespace');
  });

  it('renders each accepted image_url form as a background-image cover', () => {
    const html = renderToString(<Moodboard concepts={WITH_IMAGES} />);
    // file:// path
    expect(html).toContain('file:///Users/x/.director/generated/1717-neon.png');
    // data-URL
    expect(html).toContain('data:image/png;base64,');
    // https URL
    expect(html).toContain('https://example.com/concepts/retro.png');
    // wired as CSS background-image, not an <img src> that could 404 noisily.
    expect(html).toContain('background-image');
    // no placeholder when an image is present.
    expect(html).not.toContain('No image');
  });

  it('renders palette swatches when provided', () => {
    const html = renderToString(<Moodboard concepts={[WITH_IMAGES[0]!]} />);
    expect(html).toContain('moodboard-tile-palette');
    expect(html).toContain('moodboard-swatch');
    // swatch colors come through as inline background-color.
    expect(html).toContain('#39FF14');
  });
});

describe('Moodboard — concepts without images', () => {
  const NO_IMAGES: MoodboardConcept[] = [
    { id: 'n1', label: 'Concept A', description: 'text-only while rendering' },
    { id: 'n2', label: 'Concept B', description: '', image_url: '   ' },
  ];

  it('renders a calm per-tile placeholder instead of a broken image', () => {
    const html = renderToString(<Moodboard concepts={NO_IMAGES} />);
    expect(html).toContain('Concept A');
    expect(html).toContain('Concept B');
    // graceful no-image state — text over a neutral tile, never a 404 cover.
    expect(html).toContain('moodboard-tile-image--empty');
    expect(html).toContain('No image');
    // blank/whitespace image_url must NOT become a background-image url.
    expect(html).not.toContain('background-image');
  });
});

describe('Moodboard — defensive / empty states', () => {
  it('renders a calm empty state for zero concepts', () => {
    const html = renderToString(<Moodboard concepts={[]} />);
    expect(html).toContain('No concepts to show yet');
  });

  it('does not crash when concepts is omitted entirely', () => {
    const html = renderToString(<Moodboard title="Looks" />);
    expect(html).toContain('Looks');
    expect(html).toContain('No concepts to show yet');
  });
});
