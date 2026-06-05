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
 * set, and JSX/HTML-ish tags). Highlighting is applied AFTER HTML-escaping
 * the source, so the `dangerouslySetInnerHTML` below only ever receives
 * markup we generated from escaped text — never raw model/user code injected
 * into the canvas DOM. Unknown languages degrade gracefully to escaped,
 * un-colored monospace text.
 */

import { type JSX } from 'react';

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
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'func',
  'function', 'go', 'if', 'implements', 'import', 'in', 'instanceof',
  'interface', 'let', 'namespace', 'new', 'null', 'package', 'pass',
  'private', 'protected', 'public', 'readonly', 'return', 'static', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined',
  'var', 'void', 'while', 'with', 'yield',
]);

/**
 * Tokenize ESCAPED source into highlighted HTML. Operates on already-escaped
 * text, so the `&lt;`/`&gt;`/`&amp;`/`&quot;`/`&#39;` entities are treated as
 * single opaque units (the regexes below never split an entity).
 *
 * Order matters: comments and strings are matched first so their interiors
 * are not re-tokenized as keywords/numbers.
 */
function highlightEscaped(escaped: string): string {
  // Single master regex with named-ish alternation. Each branch is captured
  // so we can wrap the matched run in the right span; anything not matched
  // passes through untouched (already escaped).
  const pattern = new RegExp(
    [
      // line comments: // ... and # ...   (# must be start-of-token-ish)
      '(\\/\\/[^\\n]*|#[^\\n]*)',
      // block comments: /* ... */
      '(\\/\\*[\\s\\S]*?\\*\\/)',
      // double / single / backtick strings (escaped quotes are entities)
      '(&quot;(?:[^&]|&(?!quot;))*&quot;|&#39;(?:[^&]|&(?!#39;))*&#39;|`[^`]*`)',
      // numbers: ints, floats, hex
      '(\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?\\b)',
      // bare words (candidates for keyword coloring)
      '([A-Za-z_$][A-Za-z0-9_$]*)',
    ].join('|'),
    'g',
  );

  return escaped.replace(
    pattern,
    (match, lineComment, blockComment, str, num, word): string => {
      if (lineComment) return `<span class="cp-tok cp-comment">${lineComment}</span>`;
      if (blockComment) return `<span class="cp-tok cp-comment">${blockComment}</span>`;
      if (str) return `<span class="cp-tok cp-string">${str}</span>`;
      if (num) return `<span class="cp-tok cp-number">${num}</span>`;
      if (word) {
        return KEYWORDS.has(word)
          ? `<span class="cp-tok cp-keyword">${word}</span>`
          : word;
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
        {langLabel ? (
          <span className="code-preview-lang">{langLabel}</span>
        ) : null}
      </div>

      {hasCode ? (
        <div className="code-preview-scroll" data-no-drag>
          <pre className="code-preview-pre">
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
