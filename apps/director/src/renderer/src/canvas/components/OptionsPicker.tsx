/**
 * OptionsPicker — vertical list of selectable frosted option cards.
 * Schema: docs/voice-genui-spec.md §2.1 (`options_picker`).
 *
 * Interactive: click (or voice-resolved) selection → lock the list (mirrors
 * Moodboard's `selectedId` lock) → surface the choice via `onSelect(id)`.
 * The parent CanvasApp `case 'options_picker'` wraps that into the canvas
 * response path: `onRespond({ option_id: id })` (note the FIXED value key is
 * `option_id`, singular, to match `ipcSync.ts handleResumePickerResponse`).
 *
 * `sessionId`, when present, is an opaque correlation token (the resume
 * picker carries one — `buildResumePicker` in ipcSync.ts). It is echoed back
 * to the strip via the same response so the strip can correlate; this
 * component renders it into a hidden `data-session-id` attribute and the
 * Integrate wave reads `payload.props.sessionId` if it needs to echo it.
 *
 * Polish (BUILD wave): each card carries a 1-based ordinal badge so a spoken
 * "the second one" maps to the visual, and the badge doubles as a keyboard
 * hint (1–9 select directly; ↑/↓ move focus). Selection shows a check. Pure
 * presentational — no IPC, no store mutations. Single-select only (v1, no
 * `allow_multi`). Renders defensively: tolerates a missing/empty options list
 * (calm empty state) and never throws.
 */

import { useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

export interface OptionsPickerOption {
  /** Stable id, returned as `option_id` on selection. */
  id: string;
  /** Bold primary line. */
  label: string;
  /** Optional muted sub-line. */
  detail?: string;
}

export interface OptionsPickerProps {
  /** Optional eyebrow/title above the question. */
  title?: string;
  /** The prompt the user is choosing an answer to. */
  question: string;
  /** Selectable options. Tolerates an empty/missing list (empty state). */
  options: OptionsPickerOption[];
  /** Opaque correlation token (e.g. resume picker). Echoed by the parent. */
  sessionId?: string;
  /**
   * Called with the chosen option id after the selection halo settles.
   * The parent CanvasApp wraps this into `onRespond({ option_id: id })`.
   */
  onSelect?: (optionId: string) => void;
}

export function OptionsPicker({
  title,
  question,
  options,
  sessionId,
  onSelect,
}: OptionsPickerProps): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const reduced = useReducedMotion();
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Defensive: the model may emit a malformed/empty options array.
  const safeOptions = Array.isArray(options) ? options : [];

  const handleSelect = (id: string): void => {
    if (selectedId) return; // Lock after first selection (mirrors Moodboard).
    setSelectedId(id);
    // Surface the choice after the resolution-halo animation completes.
    window.setTimeout(() => onSelect?.(id), reduced ? 0 : 320);
  };

  // Roving keyboard nav: ↑/↓ (and j/k) move focus; a digit 1–9 selects the
  // matching ordinal directly (pairs with the visible badge + voice "pick 2").
  const handleKeyDown = (
    e: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (selectedId) return;
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      cardRefs.current[(index + 1) % safeOptions.length]?.focus();
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      cardRefs.current[
        (index - 1 + safeOptions.length) % safeOptions.length
      ]?.focus();
    } else if (/^[1-9]$/.test(e.key)) {
      const target = safeOptions[Number(e.key) - 1];
      if (target) {
        e.preventDefault();
        handleSelect(target.id);
      }
    }
  };

  return (
    <div className="options-picker" data-session-id={sessionId ?? undefined}>
      {title ? <div className="canvas-eyebrow">{title}</div> : null}
      {question ? (
        <div className="options-picker-question">{question}</div>
      ) : null}
      {safeOptions.length === 0 ? (
        <div className="options-picker-empty">No options to choose from.</div>
      ) : (
        <div className="options-picker-list" role="listbox" aria-label={question}>
          {safeOptions.map((option, index) => {
            const isSelected = selectedId === option.id;
            const isDimmed = selectedId !== null && !isSelected;
            return (
              <button
                key={option.id}
                ref={(el) => {
                  cardRefs.current[index] = el;
                }}
                type="button"
                role="option"
                aria-selected={isSelected}
                tabIndex={selectedId ? -1 : 0}
                className={`options-picker-card${isSelected ? ' selected' : ''}${
                  isDimmed ? ' dimmed' : ''
                }`}
                data-no-drag
                disabled={selectedId !== null && !isSelected}
                onClick={() => handleSelect(option.id)}
                onKeyDown={(e) => handleKeyDown(e, index)}
              >
                {/* Ordinal badge — 1-based; pairs voice "the second" / digit
                    keys with the visual. Becomes a check on selection. */}
                <span className="options-picker-badge" aria-hidden>
                  {isSelected && index < 9 ? '✓' : index < 9 ? index + 1 : '•'}
                </span>
                <span className="options-picker-text">
                  <span className="options-picker-label">{option.label}</span>
                  {option.detail ? (
                    <span className="options-picker-detail">
                      {option.detail}
                    </span>
                  ) : null}
                </span>
                {isSelected ? (
                  <motion.span
                    className="options-picker-halo"
                    aria-hidden
                    initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
                    animate={
                      reduced
                        ? { opacity: 1 }
                        : { opacity: [0, 1, 0.9], scale: [0.98, 1.01, 1.0] }
                    }
                    transition={{
                      duration: reduced ? 0.12 : 0.32,
                      ease: [0.32, 0.72, 0, 1],
                    }}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
