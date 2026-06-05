/**
 * DiagramView — renders a diagram description (`source`) for the Canvas.
 * Display-only (no `onRespond`). Spec: docs/voice-genui-spec.md §2.4
 * (`diagram`). The FIXED prop shape is `{ title?, kind, source }` where
 * `kind` discriminates 'mermaid' | 'dot'.
 *
 * RENDERER CHOICE / DEVIATION (see report): the spec permits either a real
 * renderer (mermaid.js for 'mermaid', Graphviz/@viz-js for 'dot') OR a
 * structured fallback "if the dep is too heavy", and says to never throw.
 * The project ships neither `mermaid` nor `@viz-js/viz`; both are heavy
 * (mermaid pulls d3 + ~hundreds of KB into the canvas bundle) and the spec
 * tracks the real renderer as an Integrate-wave task (Appendix II §2).
 *
 * Rather than dump raw source text, this BUILD-wave polish ships a
 * dependency-free STRUCTURED renderer: it parses the common shapes the Brain
 * actually emits — mermaid flowcharts (`A --> B`), sequence diagrams
 * (`A->>B: msg`), and Graphviz DOT edges (`a -> b`) — into a clean, readable
 * edge list (source → label → target) on the dark frosted surface, so a flow
 * reads as a flow. Anything it can't parse degrades to a styled, scrollable
 * `<pre>` of the raw source. Both paths are inside a try/catch that can never
 * throw (the boundary is a safety net, not the contract).
 *
 * The seam for a real graphical renderer is `renderDiagram()` — drop a
 * lazy-imported mermaid/@viz-js renderer there later without touching props
 * or wiring; keep this structured view as the render-failure fallback.
 *
 * Defensive: tolerates a missing/blank `source` (calm empty state) and an
 * unknown `kind` (still attempts to parse edges, then the `<pre>`).
 */

import { useMemo, type JSX } from 'react';

export interface DiagramViewProps {
  /** Optional card header. */
  title?: string;
  /** Diagram dialect. Drives the eyebrow label + parse strategy. */
  kind?: 'mermaid' | 'dot' | string;
  /** The diagram source text (mermaid graph DSL or Graphviz DOT). */
  source?: string;
}

/** One parsed relationship in the diagram. */
interface DiagramEdge {
  from: string;
  to: string;
  /** Edge label (mermaid `|x|` / `: x`, DOT `[label="x"]`), if any. */
  label?: string;
}

interface ParsedDiagram {
  /** Optional orientation/header line ("graph TD", "sequenceDiagram"). */
  header?: string;
  /** Ordered, de-duplicated node list (first-seen order). */
  nodes: string[];
  edges: DiagramEdge[];
}

/** Human label for the diagram dialect shown in the header eyebrow. */
function kindLabel(kind: DiagramViewProps['kind']): string {
  if (kind === 'mermaid') return 'Mermaid';
  if (kind === 'dot') return 'Graphviz DOT';
  return typeof kind === 'string' && kind.length > 0 ? kind : 'Diagram';
}

/**
 * Strip mermaid node decoration so `A["Start"]` / `B(round)` / `C{decision}`
 * render as their human label rather than the raw DSL bracket form. Falls back
 * to the bare id when there's no inner label.
 */
function cleanNode(raw: string): string {
  const id = raw.trim();
  if (!id) return id;
  // A["label"] | A('label') | A{label} | A[[label]] | A((label)) — take inner.
  const m = id.match(/^[A-Za-z0-9_.-]+[[({]+\s*"?([^"\]})]+?)"?\s*[\])}]+$/);
  if (m && m[1]) return m[1].trim();
  // Quoted DOT id: "node a" → node a.
  const q = id.match(/^"([^"]*)"$/);
  if (q) return q[1] ?? id;
  return id;
}

/**
 * Parse the common flow/edge shapes into a node+edge model. This is a
 * deliberately small, forgiving parser — it recognizes the arrow forms the
 * Brain emits most and ignores everything else (styling, subgraph wrappers,
 * classDefs). If it finds zero edges the caller shows the raw `<pre>`.
 */
function parseDiagram(source: string, kind: string): ParsedDiagram {
  let header: string | undefined;
  let body = source;

  // Graphviz wraps the graph in `digraph name { … }` / `graph { … }`. Lift the
  // declaration out as the header and parse just the brace body so the
  // `digraph foo {` / `}` lines don't masquerade as edges.
  const braceM = source.match(/^\s*((?:di)?graph\b[^{]*)\{([\s\S]*)\}\s*$/i);
  if (braceM) {
    header = braceM[1]?.trim().replace(/\s+/g, ' ');
    body = braceM[2] ?? '';
  }

  // mermaid allows multiple statements on one line separated by `;`
  // (e.g. `graph TD; A-->B; B-->C`). Split on newlines AND semicolons so each
  // statement is parsed independently; a `;` inside a quoted label is rare in
  // the shapes the Brain emits and acceptable to over-split.
  const lines = body.split(/[\n;]+/);
  const edges: DiagramEdge[] = [];
  const nodeOrder: string[] = [];
  const seen = new Set<string>();

  const noteNode = (n: string): void => {
    const c = cleanNode(n);
    if (c && !seen.has(c)) {
      seen.add(c);
      nodeOrder.push(c);
    }
  };

  // Arrow matcher covers: mermaid flow (-->, ---, -.->, ==>) with optional
  // |label|, mermaid sequence (->>, -->>, --x) with `: label`, and DOT (->, --)
  // with an optional [label="…"]. Left/right are captured up to the arrow.
  // Ordering is most-specific-first so `-.->` / `==>` / `->>` win before the
  // generic `--?` / `->` forms (alternation is left-biased).
  const flowRe = new RegExp(
    '^(.+?)\\s*(?:' +
      [
        '-\\.->', // dotted
        '==+>', // thick
        '-->>', // sequence (async, long)
        '->>', // sequence (async)
        '--x', // sequence (cross)
        '-->', // flow (solid arrow)
        '---', // flow (open link)
        '->', // DOT directed / short arrow
        '--', // DOT/flow undirected
      ].join('|') +
      ')\\s*(?:\\|([^|]*)\\|)?\\s*(.+?)\\s*$',
  );

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('%%') || line.startsWith('//')) continue;

    // Capture the leading orientation/type line once.
    if (!header && /^(graph|flowchart|sequenceDiagram|digraph|graph\s)/i.test(line)) {
      header = line.replace(/\{$/, '').trim();
      // `digraph name {` style — strip the trailing brace/name noise.
      if (/^digraph/i.test(header)) header = header.replace(/\s*\{?\s*$/, '');
      // For a `graph TD` / `flowchart LR` line there's nothing else on it.
      if (/^(graph|flowchart|sequenceDiagram|digraph)/i.test(line) && !/[-=]>/.test(line)) {
        continue;
      }
    }

    // Skip obvious non-edge structural lines.
    if (/^(subgraph|end|classDef|class|style|linkStyle|participant|actor|note)\b/i.test(line)) {
      continue;
    }

    // Strip a trailing DOT `[label="…"]` and capture the label. DOT-only:
    // mermaid uses trailing `[Text]` for NODE shapes (e.g. `E[End]`), which
    // `cleanNode` handles — stripping it here would eat the node label.
    let work = line.replace(/;+\s*$/, '');
    let dotLabel: string | undefined;
    if (kind === 'dot') {
      const attrM = work.match(/\[(.*?)\]\s*$/);
      if (attrM) {
        const labelM = attrM[1]?.match(/label\s*=\s*"?([^"\]]+)"?/i);
        if (labelM) dotLabel = labelM[1]?.trim();
        work = work.slice(0, attrM.index).trim();
      }
    }

    const m = work.match(flowRe);
    if (!m) continue;
    const fromRaw = m[1]?.trim() ?? '';
    const inlineLabel = m[2]?.trim();
    let toRaw = m[3]?.trim() ?? '';
    if (!fromRaw || !toRaw) continue;

    // mermaid sequence `: message` lives on the target side.
    let seqLabel: string | undefined;
    const colonM = toRaw.match(/^(.*?)\s*:\s*(.+)$/);
    if (colonM && kind !== 'dot') {
      toRaw = colonM[1]?.trim() ?? toRaw;
      seqLabel = colonM[2]?.trim();
    }

    const from = cleanNode(fromRaw);
    const to = cleanNode(toRaw);
    if (!from || !to) continue;
    noteNode(fromRaw);
    noteNode(toRaw);
    edges.push({
      from,
      to,
      label: inlineLabel || seqLabel || dotLabel || undefined,
    });
  }

  return { header, nodes: nodeOrder, edges };
}

/**
 * Render seam (spec §2.4 / Appendix II §2): today a structured edge view +
 * raw-source fallback. A real graphical renderer (mermaid / @viz-js, lazy
 * imported) drops in here later; keep the structured/`<pre>` paths as the
 * render-failure fallback.
 */
function renderDiagram(source: string, kind: string): JSX.Element {
  let parsed: ParsedDiagram | null = null;
  try {
    parsed = parseDiagram(source, kind);
  } catch {
    parsed = null;
  }

  // Structured view when we recognized at least two edges (a single edge is
  // just as clear as raw text; ≥2 is where the visual structure earns itself).
  if (parsed && parsed.edges.length >= 2) {
    return (
      <div className="diagram-view-scroll" data-no-drag>
        <div className="diagram-graph">
          {parsed.header ? (
            <div className="diagram-graph-header">{parsed.header}</div>
          ) : null}
          <ol className="diagram-edges">
            {parsed.edges.map((edge, i) => (
              <li className="diagram-edge" key={`${edge.from}->${edge.to}-${i}`}>
                <span className="diagram-node">{edge.from}</span>
                <span className="diagram-arrow" aria-hidden>
                  {edge.label ? (
                    <span className="diagram-edge-label">{edge.label}</span>
                  ) : null}
                  <svg
                    width="34"
                    height="10"
                    viewBox="0 0 34 10"
                    className="diagram-arrow-svg"
                    role="presentation"
                  >
                    <line x1="0" y1="5" x2="27" y2="5" />
                    <path d="M27 1 L33 5 L27 9 Z" />
                  </svg>
                </span>
                <span className="diagram-node">{edge.to}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    );
  }

  // Fallback: a clean, scrollable monospace panel of the raw source. React
  // escapes the text children, so markup in the source can never inject.
  return (
    <div className="diagram-view-scroll" data-no-drag>
      <pre className="diagram-view-source">{source}</pre>
    </div>
  );
}

export function DiagramView({
  title,
  kind,
  source,
}: DiagramViewProps = {}): JSX.Element {
  const src = typeof source === 'string' ? source : '';
  const hasSource = src.trim().length > 0;
  const label = kindLabel(kind);
  const kindStr = typeof kind === 'string' ? kind : '';

  // Memoize the (cheap) parse + render so re-renders from unrelated parent
  // state don't re-walk the source.
  const body = useMemo(
    () => (hasSource ? renderDiagram(src, kindStr) : null),
    [src, kindStr, hasSource],
  );

  return (
    <div className="diagram-view">
      <div className="diagram-view-head">
        <span className="canvas-eyebrow">{label}</span>
        {typeof title === 'string' && title.length > 0 ? (
          <span className="canvas-title">{title}</span>
        ) : null}
      </div>

      {hasSource ? (
        body
      ) : (
        <div className="diagram-view-empty">Nothing to diagram yet.</div>
      )}
    </div>
  );
}
