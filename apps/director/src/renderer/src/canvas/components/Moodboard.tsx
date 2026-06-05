/**
 * Moodboard — aesthetic / concept chooser (grid of concept cards).
 * Pencil source: Canvas / Moodboard (Gb16Y).
 *
 * Each concept is a card: a cover image, a bold label, a muted description,
 * and an optional palette swatch row. Interactive: click or voice → 500ms
 * halo on the selected tile, others dim, the grid locks, and the choice is
 * surfaced via `onSelect(conceptId)` → `onRespond({ concept_id })`.
 *
 * `image_url` accepts ANY of (docs/voice-genui-spec.md §10.2):
 *   • a bundled asset URL  (e.g. `new URL('./assets/foo.png', import.meta.url)`)
 *   • an https URL
 *   • a `data:image/...;base64,…` inline image
 * Each resolves as a CSS `background-image: url(...)` in the Electron renderer.
 * For brain-generated concept art the `generate_image` tool returns an inline
 * `data:` URL (NOT a `file://` path): the Canvas CSP is `img-src 'self' data:
 * blob:` (canvas.html), which blocks `file:`, so the on-disk
 * ~/.director/generated copy is for logs only and the moodboard always shows
 * the `data:` form. The §10 generated-image path needs no component change —
 * only a graceful per-tile no-image fallback for a concept whose image is
 * still being written (text over a neutral tile).
 *
 * Empty/loading: zero concepts → a calm empty state (matches the other
 * components); a tile with a missing/blank `image_url` renders its
 * label/description over a neutral placeholder rather than a broken image.
 *
 * Schema: docs/voice-genui-spec.md §2 / §6.6 / §10.
 * Interaction: docs/research/genui-interaction-modes.md "Per-component voice contracts".
 */

import { useState, type JSX } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

export interface MoodboardConcept {
  id: string;
  label: string;
  description: string;
  /**
   * Cover image. Accepts a bundled asset URL, an https URL, or a
   * `data:image/...;base64,…` data-URL (the form brain-generated concept art
   * arrives in — the Canvas CSP blocks `file:`). May be missing/blank while an
   * image is still being written — the tile degrades to a neutral placeholder.
   */
  image_url?: string;
  /** Optional palette swatch hexes, rendered as a small chip row. */
  palette?: string[];
}

export interface MoodboardProps {
  title?: string;
  concepts?: MoodboardConcept[];
  onSelect?: (conceptId: string) => void;
}

/** True when `image_url` is a usable image reference (any accepted form). */
function hasImage(url: string | undefined): url is string {
  return typeof url === 'string' && url.trim().length > 0;
}

/** Defensive palette read — only string entries, capped, no throw. */
function paletteOf(concept: MoodboardConcept): string[] {
  return Array.isArray(concept.palette)
    ? concept.palette.filter((c): c is string => typeof c === 'string').slice(0, 6)
    : [];
}

function MoodboardTile({
  concept,
  selected,
  dimmed,
  reduced,
  onSelect,
}: {
  concept: MoodboardConcept;
  selected: boolean;
  dimmed: boolean;
  reduced: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  const image = hasImage(concept.image_url) ? concept.image_url : null;
  const palette = paletteOf(concept);

  return (
    <button
      type="button"
      className={`moodboard-tile${dimmed ? ' dimmed' : ''}`}
      data-no-drag
      onClick={() => onSelect(concept.id)}
      aria-label={`${concept.label}: ${concept.description}`}
      aria-pressed={selected}
    >
      {image ? (
        <div
          className="moodboard-tile-image"
          style={{ backgroundImage: `url("${image}")` }}
          aria-hidden
        />
      ) : (
        // No-image (or not-yet-written) state: a calm neutral panel so the
        // tile never shows a broken image and the text stays legible.
        <div className="moodboard-tile-image moodboard-tile-image--empty" aria-hidden>
          <span className="moodboard-tile-image-placeholder">No image</span>
        </div>
      )}
      <div className="moodboard-tile-meta">
        <span className="moodboard-tile-label">{concept.label}</span>
        {concept.description ? (
          <span className="moodboard-tile-desc">{concept.description}</span>
        ) : null}
        {palette.length > 0 ? (
          <div className="moodboard-tile-palette" aria-hidden>
            {palette.map((hex, i) => (
              <span
                key={`${hex}-${i}`}
                className="moodboard-swatch"
                style={{ backgroundColor: hex }}
                title={hex}
              />
            ))}
          </div>
        ) : null}
      </div>
      {selected ? (
        <motion.div
          className="moodboard-tile-halo"
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
          animate={
            reduced
              ? { opacity: 1 }
              : { opacity: [0, 1, 0.85], scale: [0.94, 1.04, 1.0] }
          }
          transition={{
            duration: reduced ? 0.12 : 0.5,
            ease: [0.32, 0.72, 0, 1],
          }}
        />
      ) : null}
    </button>
  );
}

export function Moodboard({
  title,
  concepts,
  onSelect,
}: MoodboardProps): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const reduced = useReducedMotion();

  // Render defensively: tolerate a missing/non-array `concepts` prop.
  const list = Array.isArray(concepts) ? concepts : [];

  const handleSelect = (id: string): void => {
    if (selectedId) return; // Lock after first selection.
    setSelectedId(id);
    // Surface response after the resolution-halo animation completes.
    window.setTimeout(() => onSelect?.(id), reduced ? 0 : 500);
  };

  return (
    <div className="moodboard">
      {title ? <div className="canvas-title">{title}</div> : null}
      {list.length === 0 ? (
        <div className="moodboard-empty">No concepts to show yet.</div>
      ) : (
        <div className="moodboard-grid">
          {list.map((concept) => (
            <MoodboardTile
              key={concept.id}
              concept={concept}
              selected={selectedId === concept.id}
              dimmed={selectedId !== null && selectedId !== concept.id}
              reduced={!!reduced}
              onSelect={handleSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
