/**
 * gpt-5 planner service — main process only.
 *
 * Tier-2 of Director's 3-tier model. The Realtime layer (gpt-realtime-2)
 * handles the fast voice loop; when it needs deeper strategic thought, it
 * emits a `consult_director` function call, the tool-router forwards to
 * us, and this module calls OpenAI's Responses API with `gpt-5` +
 * `reasoning.effort: 'high'`. Reasoning-summary deltas stream back to the
 * strip renderer so the UI can show "thinking…" trail lines; the final
 * summary + decisions are returned to the tool-router so the Realtime
 * layer can narrate them.
 *
 * Spec: docs/contracts.md § 4.5 (`consult_director` tool def) + § 1
 * (process model). Side-store integration is stubbed until W3 ships
 * `main/side-store.ts`.
 *
 * P7 (W1) extensions — `docs/remaining-phases.md` §§ 7.1 + 7.2:
 *
 *   - Every consult chains via `previous_response_id`. The first consult
 *     of a session boots `lastResponseId` from the tail of
 *     `orchestrator.jsonl` (so a restart resumes the chain). Subsequent
 *     consults pass `previous_response_id: lastResponseId` and only the
 *     fresh user-turn input. `instructions` carries the harness rules,
 *     rebuilt from the side store every call (instructions live outside
 *     the compactable items array).
 *   - Every `responses.create` body carries
 *     `context_management: [{ type: 'compaction', compact_threshold: 180000 }]`
 *     as a server-side safety net.
 *   - After every response (and every manual compaction) we append one
 *     line to `orchestrator.jsonl`: `{ at, kind, responseId,
 *     previousResponseId, model, usage }`.
 *   - At quiescent moments we consult `shouldCompact()`; if it fires,
 *     `runCompaction()` runs ASYNC and queues the next consult behind it.
 *     Compaction is non-blocking — the user's next utterance still
 *     dispatches; we just await any in-flight compaction before sending.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannel } from '../shared/ipc.js';
import {
  appendOrchestratorEntry,
  readLastOrchestratorResponseId,
  type OrchestratorUsage,
} from './side-store.js';
import {
  runCompaction,
  shouldCompact,
  type CompactionStats,
} from './compaction-runner.js';

const PLANNER_MODEL = 'gpt-5';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';
/** Server-side safety net per docs/research/compaction.md § 10.1. */
const SERVER_COMPACT_THRESHOLD_TOKENS = 180_000;

const DIRECTOR_PLANNER_INSTRUCTIONS = `
You are the Director's strategic planner. Your role is to think deeply about
the user's intent and produce a structured work breakdown, decision, or
clarification that will drive the rest of the system.

Constraints:
- Be terse. Never use filler phrases.
- Always end your output with a clear DECISIONS block:
  DECISIONS:
  - <single-sentence decisions, one per line>
- The "summary" the realtime layer will narrate aloud is 1-3 sentences.

You see the user's prompt plus the current World State (active agents,
recent decisions, Harness rules) and caller context (any structured args
passed by the Realtime layer).
`.trim();

export interface ConsultArgs {
  prompt: string;
  context?: Record<string, unknown>;
}

export interface ConsultResult {
  summary: string;
  decisions: string[];
  full_text: string;
}

interface ResponsesInputItem {
  role: 'system' | 'user';
  content: string;
}

interface ResponsesStreamEvent {
  type?: string;
  delta?: string;
  text?: string;
  response?: {
    id?: string;
    usage?: OrchestratorUsage;
  };
}

/**
 * Read the side-store-derived World State. W3 owns the side-store module;
 * until it ships we return an empty stub so the planner still compiles
 * and runs end-to-end.
 */
async function readWorldState(): Promise<Record<string, unknown>> {
  // TODO(side-store): swap for `await readSideStore()` once W3 ships it.
  return {
    active_agents: [],
    harness: [],
    recent_decisions: [],
    current_task: null,
  };
}

function buildSystemInput(
  args: ConsultArgs,
  world: Record<string, unknown>,
): ResponsesInputItem[] {
  const user = [
    args.prompt,
    '',
    '## Current World State',
    '```json',
    JSON.stringify(world, null, 2),
    '```',
    '',
    '## Caller Context',
    '```json',
    JSON.stringify(args.context ?? {}, null, 2),
    '```',
  ].join('\n');

  return [
    { role: 'system', content: DIRECTOR_PLANNER_INSTRUCTIONS },
    { role: 'user', content: user },
  ];
}

/**
 * Build the input array for a chained consult. We don't re-send the
 * system block (it's carried by `previous_response_id` AND lives on the
 * `instructions` field anyway); we just append a fresh user turn.
 */
function buildChainedInput(
  args: ConsultArgs,
  world: Record<string, unknown>,
): ResponsesInputItem[] {
  const user = [
    args.prompt,
    '',
    '## Current World State',
    '```json',
    JSON.stringify(world, null, 2),
    '```',
    '',
    '## Caller Context',
    '```json',
    JSON.stringify(args.context ?? {}, null, 2),
    '```',
  ].join('\n');
  return [{ role: 'user', content: user }];
}

function parseDecisions(text: string): string[] {
  const idx = text.lastIndexOf('DECISIONS:');
  if (idx < 0) return [];
  return text
    .slice(idx + 'DECISIONS:'.length)
    .split('\n')
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .filter((line) => line.length > 0)
    .slice(0, 10);
}

// ─── Session-scoped chaining state ──────────────────────────────────────

/**
 * In-memory copy of the orchestrator session state. Persistent truth is
 * in `~/.director/sessions/<id>/orchestrator.jsonl`; this is the fast
 * read path. Booted lazily from disk on the first consult after process
 * start.
 */
interface PlannerSessionState {
  lastResponseId: string | null;
  /** Cumulative tool-output tokens since the last successful compaction. */
  cumulativeToolTokens: number;
  /** Total compactable tokens (input + output) since the last compaction. */
  tokensSinceLastCompaction: number;
  /** ms epoch of the most recent user utterance (consult prompt). */
  lastUserActivityAt: number;
  /** True after the first disk read so we don't re-read every consult. */
  booted: boolean;
}

const sessionState: PlannerSessionState = {
  lastResponseId: null,
  cumulativeToolTokens: 0,
  tokensSinceLastCompaction: 0,
  lastUserActivityAt: 0,
  booted: false,
};

/**
 * Drained when the next consult should wait for an in-flight compaction
 * (P7.2: "compaction is asynchronous non-blocking; queue next consult
 * behind it"). null when no compaction is in flight.
 */
let inFlightCompaction: Promise<void> | null = null;

/** Test hook — drop the cached chain so a fresh consult boots from disk. */
export function _resetPlannerStateForTests(): void {
  sessionState.lastResponseId = null;
  sessionState.cumulativeToolTokens = 0;
  sessionState.tokensSinceLastCompaction = 0;
  sessionState.lastUserActivityAt = 0;
  sessionState.booted = false;
  inFlightCompaction = null;
}

/** Test hook — current chain head (for asserting `previous_response_id`). */
export function _getLastResponseIdForTests(): string | null {
  return sessionState.lastResponseId;
}

async function bootChainFromDisk(): Promise<void> {
  if (sessionState.booted) return;
  sessionState.booted = true;
  try {
    const last = await readLastOrchestratorResponseId();
    if (last) {
      sessionState.lastResponseId = last;
    }
  } catch (err) {
    // Defensive — a corrupt log shouldn't block a fresh consult.
    console.warn(
      '[planner] failed to read orchestrator.jsonl tail; starting fresh chain',
      err,
    );
  }
}

// ─── Compaction trigger glue ────────────────────────────────────────────

/**
 * Inject hooks so this module is unit-testable without a live OpenAI
 * client. Production passes a real client; tests pass a stub.
 */
type AnyOpenAI = Parameters<typeof runCompaction>[0];
let compactionClient: AnyOpenAI | null = null;

/** Wire-up — call once from main bootstrap if you want manual compaction. */
export function setCompactionClient(client: AnyOpenAI | null): void {
  compactionClient = client;
}

/**
 * Run compaction in the background and stash the promise so the next
 * consult can await it. Never throws — failures are logged + recorded in
 * the orchestrator log.
 */
function fireCompactionAsync(reason: string): void {
  if (!compactionClient) {
    // No client wired — fall back to server-side `context_management`.
    return;
  }
  if (!sessionState.lastResponseId) return;
  if (inFlightCompaction) return; // already in flight; don't pile up

  const previousResponseId = sessionState.lastResponseId;
  const client = compactionClient;
  inFlightCompaction = (async () => {
    try {
      const result = await runCompaction(client, previousResponseId);
      if (result.ok && result.newResponseId) {
        sessionState.lastResponseId = result.newResponseId;
        sessionState.cumulativeToolTokens = 0;
        sessionState.tokensSinceLastCompaction = 0;
      }
      try {
        await appendOrchestratorEntry({
          at: Date.now(),
          kind: 'compaction',
          responseId: result.newResponseId,
          previousResponseId,
          model: PLANNER_MODEL,
          usage: result.usage ?? null,
          summary: result.ok
            ? `manual:${reason}`
            : `manual:${reason}:fallback=${result.fallback ?? 'unknown'}${
                result.detail ? `:${result.detail}` : ''
              }`,
        });
      } catch (logErr) {
        console.warn(
          '[planner] failed to append compaction entry to orchestrator.jsonl',
          logErr,
        );
      }
      if (!result.ok) {
        console.warn(
          `[planner] compaction (${reason}) returned non-ok`,
          result.fallback,
          result.detail,
        );
      }
    } catch (err) {
      console.warn('[planner] compaction failed unexpectedly', err);
    } finally {
      inFlightCompaction = null;
    }
  })();
}

/**
 * After every response, decide whether to fire a manual compaction. The
 * decision is pure (`shouldCompact`); the side effect (`fireCompactionAsync`)
 * is fire-and-forget.
 */
function maybeFireCompactionAfterResponse(opts?: {
  preRotation?: boolean;
}): void {
  const stats: CompactionStats = {
    cumulativeToolTokens: sessionState.cumulativeToolTokens,
    tokensSinceLastCompaction: sessionState.tokensSinceLastCompaction,
    lastUserActivityAt: sessionState.lastUserActivityAt,
    nowMs: Date.now(),
  };
  const verdict = shouldCompact(stats, opts);
  if (verdict.fire) {
    fireCompactionAsync(verdict.reason ?? 'unknown');
  }
}

/**
 * Public hook for the rotation coordinator (P6.1): "I'm about to swap
 * Session_A for Session_B — please compact first so the brief gets a
 * clean planner state." Awaits any in-flight compaction so the caller
 * can sequence around it.
 */
export async function preRotationCompaction(): Promise<void> {
  await bootChainFromDisk();
  if (!sessionState.lastResponseId) return;
  maybeFireCompactionAfterResponse({ preRotation: true });
  if (inFlightCompaction) {
    await inFlightCompaction;
  }
}

// ─── Body assembly ──────────────────────────────────────────────────────

interface ResponsesBody {
  model: string;
  /** If chained, only the fresh user-turn input; else system + user. */
  input: ResponsesInputItem[];
  /** Harness rules + the planner system block. Lives outside compaction. */
  instructions: string;
  reasoning: { effort: string; summary: string };
  stream: boolean;
  max_output_tokens: number;
  store: false;
  context_management: Array<{
    type: 'compaction';
    compact_threshold: number;
  }>;
  previous_response_id?: string;
}

function buildBody(
  args: ConsultArgs,
  world: Record<string, unknown>,
  previousResponseId: string | null,
): ResponsesBody {
  const isFirst = !previousResponseId;
  const body: ResponsesBody = {
    model: PLANNER_MODEL,
    input: isFirst ? buildSystemInput(args, world) : buildChainedInput(args, world),
    // Instructions ALWAYS carries the harness rules so they survive
    // compaction (per compaction.md § 10.2 — only user msgs + instructions
    // are exempt from the encrypted blob).
    instructions: DIRECTOR_PLANNER_INSTRUCTIONS,
    reasoning: { effort: 'high', summary: 'auto' },
    stream: true,
    max_output_tokens: 4096,
    store: false,
    context_management: [
      {
        type: 'compaction',
        compact_threshold: SERVER_COMPACT_THRESHOLD_TOKENS,
      },
    ],
  };
  if (!isFirst && previousResponseId) {
    body.previous_response_id = previousResponseId;
  }
  return body;
}

// ─── Test surface for the fetch transport (unit-tests inject a mock) ────

type FetchLike = typeof fetch;
let fetchOverride: FetchLike | null = null;

/** Test hook — install a mock fetch (useful for the integration test). */
export function _setFetchForTests(fn: FetchLike | null): void {
  fetchOverride = fn;
}

function getFetch(): FetchLike {
  return fetchOverride ?? fetch;
}

// ─── Main entry point ──────────────────────────────────────────────────

/**
 * Main entry point. Called from the tool-router on `consult_director` tool
 * calls. Streams `planner.reasoning.delta` IPC events to the strip
 * renderer if `mainWindow` is provided; returns the final synthesis once
 * the Responses stream terminates.
 */
export async function consultDirector(
  args: ConsultArgs,
  mainWindow?: BrowserWindow | null,
): Promise<ConsultResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('[planner] OPENAI_API_KEY missing in main process env');
  }

  // P7.2: queue this consult behind any in-flight compaction. Compaction
  // either advances `lastResponseId` to its new value or no-ops; either
  // way we want to read the post-compaction chain head.
  if (inFlightCompaction) {
    try {
      await inFlightCompaction;
    } catch {
      /* failures already logged inside fireCompactionAsync */
    }
  }

  await bootChainFromDisk();
  sessionState.lastUserActivityAt = Date.now();

  const world = await readWorldState();
  const previousResponseId = sessionState.lastResponseId;
  const body = buildBody(args, world, previousResponseId);

  const resp = await getFetch()(RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '<no body>');
    throw new Error(
      `[planner] Responses API ${resp.status}: ${errText.slice(0, 500)}`,
    );
  }
  if (!resp.body) {
    throw new Error('[planner] Responses API returned no body');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let reasoningSummary = '';
  let finalText = '';
  let newResponseId: string | null = null;
  let usage: OrchestratorUsage | null = null;

  const emit = (channel: string, payload: unknown): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send(channel, payload);
      } catch {
        /* renderer gone — ignore */
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line. Drain complete events from
      // the buffer; leave any trailing partial event in place.
      let sepIdx: number;
      while ((sepIdx = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);

        const dataLines = rawEvent
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice('data: '.length));

        if (dataLines.length === 0) continue;
        const dataStr = dataLines.join('\n');
        if (dataStr === '[DONE]') continue;

        let event: ResponsesStreamEvent;
        try {
          event = JSON.parse(dataStr);
        } catch {
          continue;
        }

        // Be permissive on the reasoning event name — OpenAI has used both
        // response.reasoning_summary_text.delta and response.reasoning_text.delta
        // across model versions. If we ever see neither + nothing in output,
        // diagnostic log below will surface it.
        if (
          (event.type === 'response.reasoning_summary_text.delta' ||
            event.type === 'response.reasoning_text.delta' ||
            event.type === 'response.reasoning.delta') &&
          typeof event.delta === 'string'
        ) {
          reasoningSummary += event.delta;
          emit(IpcChannel.PlannerReasoningDelta, { delta: event.delta });
        } else if (
          event.type === 'response.output_text.delta' &&
          typeof event.delta === 'string'
        ) {
          finalText += event.delta;
        } else if (
          event.type === 'response.created' ||
          event.type === 'response.completed'
        ) {
          // Capture the id + usage off the wrapped response object. The
          // server sends `response.created` first (id stable from then on)
          // and `response.completed` last (usage fully populated).
          if (typeof event.response?.id === 'string') {
            newResponseId = event.response.id;
          }
          if (event.response?.usage) {
            usage = event.response.usage;
          }
        } else if (event.type === 'response.failed' || event.type === 'error') {
          // Surface API errors to the caller so we don't silently return empty.
          const errMsg =
            (event as { error?: { message?: string } }).error?.message ??
            (event as { message?: string }).message ??
            'unknown planner error';
          console.error('[planner] stream error event:', errMsg, event);
          throw new Error(`[planner] stream error: ${errMsg}`);
        }
        // Other event types are informational; we don't need them for the
        // synthesis. The id + usage we care about ride on
        // response.created / response.completed above.
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released or stream cancelled — ignore */
    }
  }

  const decisions = parseDecisions(finalText);
  const summary = reasoningSummary.trim() || finalText.trim().slice(0, 280);

  // Diagnostic: if we got nothing at all, the SSE event types may have
  // shifted on the API side. Log so we can spot it fast.
  if (!summary && !finalText) {
    console.warn(
      '[planner] stream produced no usable text — check Responses API event names',
    );
  }

  // Advance the chain BEFORE logging so the orchestrator entry reflects
  // the new head. If we never saw an id (extremely unlikely — the API
  // emits response.created very early), retain the previous chain.
  if (newResponseId) {
    sessionState.lastResponseId = newResponseId;
  }

  // Update token counters using whatever usage the API surfaced. Both
  // sides clamp; missing fields contribute 0.
  const outputTokens =
    typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0;
  const totalTokens =
    typeof usage?.total_tokens === 'number'
      ? usage.total_tokens
      : (typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0) +
        outputTokens;
  sessionState.cumulativeToolTokens += outputTokens;
  sessionState.tokensSinceLastCompaction += totalTokens;

  // Append the orchestrator log line. Failures here are non-fatal — the
  // planner already returned a useful result to the caller.
  try {
    await appendOrchestratorEntry({
      at: Date.now(),
      kind: 'response',
      responseId: newResponseId,
      previousResponseId,
      model: PLANNER_MODEL,
      usage,
      summary: summary.slice(0, 200) || undefined,
    });
  } catch (err) {
    console.warn(
      '[planner] failed to append response entry to orchestrator.jsonl',
      err,
    );
  }

  // Quiescent-moment compaction check — fire-and-forget so this consult
  // returns immediately. The NEXT consult will wait on the promise.
  maybeFireCompactionAfterResponse();

  return { summary, decisions, full_text: finalText };
}

/**
 * Dev-only IPC handler so the renderer (or a future debug surface) can
 * invoke the planner directly without going through Realtime.
 */
export function registerPlannerDevIpc(mainWindow: BrowserWindow | null): void {
  ipcMain.handle(
    IpcChannel.PlannerConsult,
    async (
      _evt,
      args: ConsultArgs,
    ): Promise<{ ok: true; result: ConsultResult } | { ok: false; error: string }> => {
      try {
        const result = await consultDirector(args, mainWindow);
        return { ok: true, result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
  );
}
