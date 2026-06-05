/**
 * CodePreview — read-only, syntax-highlighted code block on a near-black
 * panel with a line-number gutter. Display-only (no `onRespond`).
 *
 * Spec: docs/voice-genui-spec.md §2.3 (`code_preview`). No actions / no diff
 * in v1 — the fan-in approval flow in `codex-pool.ts` renders this card
 * display-only.
 *
 * Highlighter: intentionally dependency-free. The project does not ship
 * `highlight.js` / `prismjs`, and the spec says "correctness > color" and to
 * avoid adding a heavy dep. We use a tiny, XSS-safe regex tokenizer that
 * handles the common surface (comments, strings, numbers, a generic keyword
 * set, JSX/HTML tags + attributes, and the boolean/null literals). The
 * tokenizer runs AFTER HTML-escaping the source, so the
 * `dangerouslySetInnerHTML` below only ever receives markup we generated from
 * escaped text — never raw model/user code injected into the canvas DOM.
 * Unknown languages still get comment/string/number/keyword coloring.
 *
 * Polish (BUILD wave): JSX/HTML tag coloring (so `<div>` reads as markup, not
 * an un-colored entity run), a copy-to-clipboard affordance, and a line count
 * in the header. The gutter stays 1:1 with the code lines.
 */

import { useState, type JSX } from 'react';

export interface CodePreviewProps {
  /** Card header fallback when `path` is absent. */
  title?: string;
  /** File path; preferred header label when present. */
  path?: string;
  /** Highlighter hint (e.g. 'ts', 'tsx', 'js', 'python'); default plaintext. */
  language?: string;
  /** The code to render. Required in practice; tolerated empty. */
  code?: string;
}

/** HTML-escape so highlighting can wrap spans without injection risk. */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A deliberately small, language-agnostic keyword set covering the languages
// the Brain / Codex agents most often emit (JS/TS, Python, shell, Go-ish).
// Missing a keyword only costs a little color — never correctness.
const KEYWORDS = new Set([
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class',
  'const', 'continue', 'def', 'default', 'delete', 'do', 'elif', 'else',
  'enum', 'export', 'extends', 'finally', 'for', 'from', 'func',
  'function', 'go', 'if', 'implements', 'import', 'in', 'instanceof',
  'interface', 'let', 'namespace', 'new', 'package', 'pass',
  'private', 'protected', 'public', 'readonly', 'return', 'static', 'super',
  'switch', 'this', 'throw', 'try', 'type', 'typeof',
  'var', 'void', 'while', 'with', 'yield',
]);

// The literal/constant set is colored distinctly from control keywords so a
// `true`/`null` reads as a value, matching most editor themes.
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil']);

/**
 * Tokenize ESCAPED source into highlighted HTML. Operates on already-escaped
 * text, so the `&lt;`/`&gt;`/`&amp;`/`&quot;`/`&#39;` entities are treated as
 * single opaque units (the regexes below never split an entity).
 *
 * Order matters: comments and strings are matched first so their interiors
 * are not re-tokenized; tags are matched before bare words so `&lt;div&gt;`
 * colors as markup.
 */
function highlightEscaped(escaped: string): string {
  // Single master regex with ordered alternation. Each branch is captured so
  // we can wrap the matched run in the right span; anything not matched passes
  // through untouched (already escaped).
  const pattern = new RegExp(
    [
      // 1 line comments: // ... and # ...
      '(\\/\\/[^\\n]*|#[^\\n]*)',
      // 2 block comments: /* ... */
      '(\\/\\*[\\s\\S]*?\\*\\/)',
      // 3 double / single / backtick strings (escaped quotes are entities)
      '(&quot;(?:[^&]|&(?!quot;))*&quot;|&#39;(?:[^&]|&(?!#39;))*&#39;|`[^`]*`)',
      // 4 JSX/HTML tag open/close: &lt;Tag … &gt;  /  &lt;/Tag&gt;  /  self-close
      '(&lt;\\/?[A-Za-z][A-Za-z0-9.-]*(?:[^&]|&(?!gt;))*?&gt;)',
      // 5 numbers: ints, floats, hex
      '(\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?\\b)',
      // 6 bare words (keyword / literal / plain)
      '([A-Za-z_$][A-Za-z0-9_$]*)',
    ].join('|'),
    'g',
  );

  return escaped.replace(
    pattern,
    (match, lineComment, blockComment, str, tag, num, word): string => {
      if (lineComment) return `<span class="cp-tok cp-comment">${lineComment}</span>`;
      if (blockComment) return `<span class="cp-tok cp-comment">${blockComment}</span>`;
      if (str) return `<span class="cp-tok cp-string">${str}</span>`;
      if (tag) return `<span class="cp-tok cp-tag">${tag}</span>`;
      if (num) return `<span class="cp-tok cp-number">${num}</span>`;
      if (word) {
        if (KEYWORDS.has(word)) return `<span class="cp-tok cp-keyword">${word}</span>`;
        if (LITERALS.has(word)) return `<span class="cp-tok cp-literal">${word}</span>`;
        return word;
      }
      return match;
    },
  );
}

export function CodePreview({
  title,
  path,
  language,
  code,
}: CodePreviewProps = {}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const source = typeof code === 'string' ? code : '';
  const header =
    (typeof path === 'string' && path.length > 0 && path) ||
    (typeof title === 'string' && title.length > 0 && title) ||
    null;
  const langLabel =
    typeof language === 'string' && language.length > 0
      ? language.toLowerCase()
      : null;

  // Split on \n so the gutter and the code lines stay 1:1. A trailing
  // newline yields a final empty line which we drop to avoid a phantom row.
  const rawLines = source.split('\n');
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  const hasCode = source.length > 0;
  // Gutter width scales with the line count so 3-digit files don't clip.
  const gutterCh = Math.max(2, String(rawLines.length).length) + 1;

  const handleCopy = (): void => {
    // navigator.clipboard is async + may be unavailable (non-secure context /
    // node test render) — guard and fail silently; copy is a nicety, not a
    // contract.
    try {
      void navigator?.clipboard?.writeText(source);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* no-op: copy is best-effort */
    }
  };

  return (
    <div className="code-preview">
      <div className="code-preview-head">
        {header ? (
          <span className="code-preview-path" title={header}>
            {header}
          </span>
        ) : (
          <span className="canvas-eyebrow">Code</span>
        )}
        <span className="code-preview-head-right">
          {langLabel ? (
            <span className="code-preview-lang">{langLabel}</span>
          ) : null}
          {hasCode ? (
            <button
              type="button"
              className="code-preview-copy"
              data-no-drag
              onClick={handleCopy}
              aria-label={copied ? 'Copied' : 'Copy code'}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          ) : null}
        </span>
      </div>

      {hasCode ? (
        <div className="code-preview-scroll" data-no-drag>
          <pre
            className="code-preview-pre"
            style={{ ['--cp-gutter' as string]: `${gutterCh}ch` }}
          >
            <code className="code-preview-code">
              {rawLines.map((line, i) => {
                const escaped = escapeHtml(line);
                const html = highlightEscaped(escaped);
                return (
                  <span className="code-preview-line" key={i}>
                    <span className="code-preview-ln" aria-hidden>
                      {i + 1}
                    </span>
                    <span
                      className="code-preview-lc"
                      // Safe: `html` is generated from HTML-escaped `line`.
                      dangerouslySetInnerHTML={{ __html: html || '​' }}
                    />
                  </span>
                );
              })}
            </code>
          </pre>
        </div>
      ) : (
        <div className="code-preview-empty">No code to preview yet.</div>
      )}
    </div>
  );
}
