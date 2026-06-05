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
 * component renders it into a hidden `data-session-id` attribute and forwards
 * it through `onSelect`'s second-arg-free contract by leaving correlation to
 * the parent, which already has `sessionId` on the payload props. (We keep the
 * `onSelect` signature to one arg to match Moodboard; the Integrate wave reads
 * `payload.props.sessionId` if it needs to echo it.)
 *
 * Pure presentational — no IPC, no store mutations. Single-select only (v1,
 * no `allow_multi`). Renders defensively: tolerates a missing/empty options
 * list (calm empty state) and never throws.
 */

import { useState, type JSX } from 'react';
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

  // Defensive: the model may emit a malformed/empty options array.
  const safeOptions = Array.isArray(options) ? options : [];

  const handleSelect = (id: string): void => {
    if (selectedId) return; // Lock after first selection (mirrors Moodboard).
    setSelectedId(id);
    // Surface the choice after the resolution-halo animation completes.
    window.setTimeout(() => onSelect?.(id), reduced ? 0 : 320);
  };

  return (
    <div
      className="options-picker"
      data-session-id={sessionId ?? undefined}
    >
      {title ? <div className="canvas-eyebrow">{title}</div> : null}
      {question ? (
        <div className="options-picker-question">{question}</div>
      ) : null}
      {safeOptions.length === 0 ? (
        <div className="options-picker-empty">No options to choose from.</div>
      ) : (
        <div className="options-picker-list" role="listbox">
          {safeOptions.map((option) => {
            const isSelected = selectedId === option.id;
            const isDimmed = selectedId !== null && !isSelected;
            return (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`options-picker-card${isSelected ? ' selected' : ''}${
                  isDimmed ? ' dimmed' : ''
                }`}
                data-no-drag
                disabled={selectedId !== null && !isSelected}
                onClick={() => handleSelect(option.id)}
              >
                <span className="options-picker-label">{option.label}</span>
                {option.detail ? (
                  <span className="options-picker-detail">{option.detail}</span>
                ) : null}
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
