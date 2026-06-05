/**
 * ArtifactPreview — final-reveal artifact card. Renders STRICTLY from props.
 *
 * Generic artifact shape (docs/voice-genui-spec.md §2.6): a framed preview of
 * an iframe URL, an image, or sandboxed model-authored HTML, plus optional
 * Ship / Iterate / Discard actions. When no `src`/`html` is supplied it shows
 * a calm empty state — it NEVER falls back to demo data.
 *
 * The Mixtape flip-card chrome is retained only when an explicit `mixtape`
 * object is passed (the demo trigger: ChatSurface "Start Mixtape Demo" + the
 * dev `⌃⌥⌘A` hotkey both pass the full mixtape props). There is no hardcoded
 * `MOCK_MIXTAPE` fallback and no implicit `http://localhost:3001` iframe — an
 * omitted field renders an empty state, not Tokyo-neon tracks.
 */

import { useState, type JSX } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

export type ArtifactAction = 'ship' | 'iterate' | 'discard';

/** Legacy demo shape — only rendered when explicitly provided (no defaults). */
export interface MixtapeTrack {
  title: string;
  artist: string;
  runtime: string;
}

export interface MixtapeData {
  vibe: string;
  tracks: MixtapeTrack[];
  coverUrl: string;
}

export interface ArtifactPreviewProps {
  title?: string;
  kind?: 'iframe' | 'image' | 'html';
  /** URL / data-url for kind === 'iframe' | 'image'. */
  src?: string;
  /** Model-authored HTML for kind === 'html' (sandboxed, no scripts — §2.2). */
  html?: string;
  notes?: string;
  actions?: ArtifactAction[];
  onAction?: (action: ArtifactAction) => void;
  /**
   * Structured demo artifact (Mixtape flip-card). Only the explicit demo
   * triggers pass this; production callers use the generic fields above.
   */
  mixtape?: MixtapeData;
}

function ActionButtons({
  actions,
  onAction,
}: {
  actions: ArtifactAction[];
  onAction?: (action: ArtifactAction) => void;
}): JSX.Element | null {
  if (actions.length === 0) return null;
  return (
    <div className="artifact-actions">
      {actions.includes('ship') ? (
        <button
          type="button"
          className="artifact-action primary"
          data-no-drag
          onClick={() => onAction?.('ship')}
        >
          Ship
        </button>
      ) : null}
      {actions.includes('iterate') ? (
        <button
          type="button"
          className="artifact-action"
          data-no-drag
          onClick={() => onAction?.('iterate')}
        >
          Iterate
        </button>
      ) : null}
      {actions.includes('discard') ? (
        <button
          type="button"
          className="artifact-action danger"
          data-no-drag
          onClick={() => onAction?.('discard')}
        >
          Discard
        </button>
      ) : null}
    </div>
  );
}

/**
 * Mixtape flip-card — rendered ONLY when an explicit `mixtape` is provided.
 * No demo fallback lives here; an empty/garbled mixtape simply renders the
 * chrome with whatever real fields were passed.
 */
function MixtapeCard({
  mixtape,
  notes,
}: {
  mixtape: MixtapeData;
  notes?: string;
}): JSX.Element {
  const [flipped, setFlipped] = useState(false);
  const reduced = useReducedMotion();
  const tracks = Array.isArray(mixtape.tracks) ? mixtape.tracks : [];

  const totalRuntime = tracks.reduce((sum, t) => {
    const [m, s] = String(t.runtime ?? '').split(':').map(Number);
    return sum + (m ?? 0) * 60 + (s ?? 0);
  }, 0);
  const totalMin = Math.floor(totalRuntime / 60);
  const totalSec = totalRuntime % 60;
  const totalStr = `${totalMin}:${String(totalSec).padStart(2, '0')}`;

  return (
    <div className="artifact-frame">
      <motion.div
        className="artifact-card"
        animate={reduced ? { rotateY: 0 } : { rotateY: flipped ? 180 : 0 }}
        transition={
          reduced ? { duration: 0 } : { type: 'spring', stiffness: 180, damping: 22 }
        }
        style={{ transformStyle: 'preserve-3d' }}
      >
        {/* Front face — cover + tracklist. */}
        <div className="artifact-card-front">
          <button
            type="button"
            className="artifact-cover"
            data-no-drag
            onClick={() => setFlipped((f) => !f)}
            aria-label="Flip cover"
            style={{
              backgroundImage: mixtape.coverUrl
                ? `url(${mixtape.coverUrl})`
                : undefined,
            }}
          >
            <div className="artifact-cover-overlay">
              <span className="artifact-tag">
                Mixtape · {tracks.length} tracks · {totalStr}
              </span>
              <span className="artifact-vibe">{mixtape.vibe}</span>
            </div>
          </button>

          <div className="artifact-tracks">
            {tracks.map((track, i) => (
              <div className="artifact-track" key={`${track.title}-${i}`}>
                <span className="artifact-track-num">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="artifact-track-meta">
                  <span className="artifact-track-title">{track.title}</span>
                  <span className="artifact-track-artist">{track.artist}</span>
                </div>
                <span className="artifact-track-runtime">{track.runtime}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Back face — minimal meta. */}
        <div className="artifact-card-back">
          <span className="canvas-eyebrow">Mixtape</span>
          <div className="canvas-title">{mixtape.vibe}</div>
          <span className="artifact-meta">
            {tracks.length} tracks · {totalStr} runtime
          </span>
          {notes ? <span className="artifact-meta">{notes}</span> : null}
        </div>
      </motion.div>
    </div>
  );
}

export function ArtifactPreview({
  title,
  kind,
  src,
  html,
  notes,
  actions,
  onAction,
  mixtape,
}: ArtifactPreviewProps): JSX.Element {
  // Actions only surface when a handler is wired (interactive). Default to the
  // full set in that case; never render dangling buttons for a display-only card.
  const resolvedActions: ArtifactAction[] = onAction
    ? Array.isArray(actions)
      ? actions
      : ['ship', 'iterate', 'discard']
    : Array.isArray(actions)
      ? actions
      : [];

  const trimmedSrc = typeof src === 'string' ? src.trim() : '';
  const trimmedHtml = typeof html === 'string' ? html.trim() : '';

  // Body precedence: explicit mixtape demo → iframe → image → html → empty.
  let body: JSX.Element;
  if (mixtape) {
    body = <MixtapeCard mixtape={mixtape} notes={notes} />;
  } else if (kind === 'iframe' && trimmedSrc) {
    body = (
      <div className="artifact-frame">
        <div className="artifact-card" style={{ background: 'transparent' }}>
          <iframe
            title={title ?? 'Artifact preview'}
            src={trimmedSrc}
            style={{
              width: '100%',
              height: '100%',
              border: 0,
              background: 'transparent',
            }}
          />
        </div>
      </div>
    );
  } else if (kind === 'image' && trimmedSrc) {
    body = (
      <div className="artifact-frame">
        <div
          className="artifact-card"
          style={{
            backgroundImage: `url(${trimmedSrc})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        />
      </div>
    );
  } else if (kind === 'html' && trimmedHtml) {
    // Sandboxed (no scripts, no same-origin) — model-authored HTML is inert.
    body = (
      <div className="artifact-frame">
        <div className="artifact-card" style={{ background: 'rgba(14,14,16,0.92)' }}>
          <iframe
            title={title ?? 'Artifact preview'}
            sandbox=""
            srcDoc={trimmedHtml}
            style={{
              width: '100%',
              height: '100%',
              border: 0,
              background: 'transparent',
            }}
          />
        </div>
      </div>
    );
  } else {
    // Calm empty state — NEVER demo data.
    body = (
      <div className="artifact-frame">
        <div className="canvas-empty">Nothing to preview yet</div>
      </div>
    );
  }

  return (
    <div className="artifact">
      {title ? <div className="canvas-title">{title}</div> : null}
      {body}
      {notes && !mixtape ? <span className="artifact-meta">{notes}</span> : null}
      <ActionButtons actions={resolvedActions} onAction={onAction} />
    </div>
  );
}
