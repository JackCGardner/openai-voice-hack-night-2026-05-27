/**
 * HtmlView — renders model-authored HTML inside a fully-sandboxed iframe.
 * Schema: docs/voice-genui-spec.md §2.2 (`html` component).
 *
 * SECURITY (FIXED, §2.2): the iframe `sandbox` attribute is `""` — fully
 * sandboxed: no `allow-scripts` (model HTML does NOT execute JavaScript),
 * no `allow-same-origin` (the frame cannot reach the app's origin/DOM/
 * storage). Inert HTML + inline CSS still render. The markup is passed via
 * `srcDoc`, NEVER via `dangerouslySetInnerHTML` into the canvas DOM — it must
 * be iframe-isolated so arbitrary model output can't run against the app.
 *
 * Display-only — no `onRespond`. Optional `title` renders as the card header.
 * Renders defensively: a missing/empty `html` shows a calm empty state and
 * the iframe is still inert.
 */

import type { JSX } from 'react';

export interface HtmlViewProps {
  /** Optional card header. */
  title?: string;
  /** Model-authored HTML. Rendered inert (no scripts) inside the iframe. */
  html: string;
}

export function HtmlView({ title, html }: HtmlViewProps): JSX.Element {
  // Defensive: the model may omit/null the html field.
  const safeHtml = typeof html === 'string' ? html : '';
  const hasHtml = safeHtml.trim().length > 0;

  return (
    <div className="html-view">
      {title ? <div className="canvas-title">{title}</div> : null}
      {hasHtml ? (
        <iframe
          className="html-view-frame"
          // Fully sandboxed: empty sandbox = no scripts, no same-origin.
          // Do NOT add allow-scripts / allow-same-origin (see §2.2).
          sandbox=""
          // referrerPolicy hardens against leaking the app origin via any
          // inert subresource the markup might reference.
          referrerPolicy="no-referrer"
          srcDoc={safeHtml}
          title={title ?? 'Rendered HTML'}
          data-no-drag
        />
      ) : (
        <div className="html-view-empty">Nothing to render.</div>
      )}
    </div>
  );
}
