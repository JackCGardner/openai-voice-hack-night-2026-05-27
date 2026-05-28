/**
 * Compaction runner — decides WHEN to compact and EXECUTES the compaction
 * round-trip against the Responses API.
 *
 * Two pure-ish surfaces:
 *
 *   - `shouldCompact(stats, opts)` — pure decision function. Inputs are
 *     usage / activity counters; output is a `{ fire, reason }` verdict.
 *     Used by the planner at quiescent moments to decide whether to fire
 *     a manual `responses.compact`. Three trigger conditions per
 *     docs/remaining-phases.md § 7.2:
 *       1. cumulative-tool — >50k tokens of tool output since the last
 *          compaction (Codex diffs + stack traces can be huge).
 *       2. idle-large — user idle ≥ 90s AND >80k tokens in flight.
 *       3. pre-rotation — explicit precondition for session rotation
 *          (caller passes `opts.preRotation = true`).
 *
 *   - `runCompaction(client, lastResponseId)` — invokes the standalone
 *     `responses.compact` endpoint (per `docs/research/compaction.md` § 1b).
 *     Designed to be non-blocking: caller awaits the promise, but the
 *     planner only queues the next consult behind a settled compaction.
 *
 *     Graceful fallback: if `client.responses.compact` doesn't exist on
 *     the installed SDK version, we fall back to a direct fetch against
 *     `/v1/responses/compact`. If THAT 404s (endpoint not in this
 *     account's API surface yet), we log a warning and return a noop
 *     result — the `context_management` safety net on every
 *     `responses.create` keeps the orchestrator alive in that case.
 *
 * Both surfaces are testable without Electron, fetch, or fs. The planner
 * is the only consumer.
 */

import type OpenAI from 'openai';

// ─── shouldCompact ─────────────────────────────────────────────────────

/**
 * Numeric/temporal counters the planner mirrors as it runs. All fields
 * are tolerant of out-of-band values — clamps to 0 if missing.
 *
 *   cumulativeToolTokens     — sum of `usage.output_tokens` across every
 *                              tool-call round-trip since the last
 *                              compaction landed.
 *   tokensSinceLastCompaction — total tokens in the orchestrator's
 *                              compactable window (assistant + tool +
 *                              reasoning). User messages are kept by
 *                              compaction, so they're tracked but not
 *                              the primary signal.
 *   lastUserActivityAt       — ms epoch of the last user utterance, used
 *                              to detect quiescent idle moments.
 *   nowMs                    — caller-provided `Date.now()`. Injectable
 *                              so unit tests don't depend on clock skew.
 */
export interface CompactionStats {
  cumulativeToolTokens: number;
  tokensSinceLastCompaction: number;
  lastUserActivityAt: number;
  nowMs: number;
}

export type ShouldCompactReasonName =
  | 'cumulative-tool'
  | 'idle-large'
  | 'pre-rotation';

export interface ShouldCompactReason {
  fire: boolean;
  reason?: ShouldCompactReasonName;
}

export interface ShouldCompactOptions {
  /** ms; defaults to 90_000. Idle-large trigger requires being idle this long. */
  idleThresholdMs?: number;
  /** Caller asserts a session rotation is imminent — short-circuit fire. */
  preRotation?: boolean;
}

/** Threshold in tokens for the cumulative-tool trigger. */
export const CUMULATIVE_TOOL_TRIGGER_TOKENS = 50_000;
/** Threshold in tokens for the idle-large trigger. */
export const IDLE_LARGE_TRIGGER_TOKENS = 80_000;
/** Default idle window (ms) for the idle-large trigger. */
export const DEFAULT_IDLE_THRESHOLD_MS = 90_000;

function clampNonNegative(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n;
}

/**
 * Pure decision: should we fire a manual compaction NOW?
 *
 * Precedence (highest wins):
 *   1. pre-rotation (caller-asserted, can't be overridden)
 *   2. cumulative-tool (>50k tokens of tool output)
 *   3. idle-large (idle ≥ idleThreshold AND >80k tokens)
 *
 * Returns `{ fire: false }` if none of the conditions hit. Defensive: any
 * out-of-band field falls back to 0, so a corrupt stats object can't
 * spuriously fire.
 */
export function shouldCompact(
  stats: CompactionStats,
  opts?: ShouldCompactOptions,
): ShouldCompactReason {
  const idleThresholdMs = Math.max(
    0,
    opts?.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS,
  );

  if (opts?.preRotation === true) {
    return { fire: true, reason: 'pre-rotation' };
  }

  const cumulativeToolTokens = clampNonNegative(stats?.cumulativeToolTokens);
  if (cumulativeToolTokens > CUMULATIVE_TOOL_TRIGGER_TOKENS) {
    return { fire: true, reason: 'cumulative-tool' };
  }

  const tokensSinceLastCompaction = clampNonNegative(
    stats?.tokensSinceLastCompaction,
  );
  const lastUserActivityAt = clampNonNegative(stats?.lastUserActivityAt);
  const nowMs = clampNonNegative(stats?.nowMs);
  const idleMs = lastUserActivityAt > 0 ? nowMs - lastUserActivityAt : 0;
  if (
    idleMs >= idleThresholdMs &&
    tokensSinceLastCompaction > IDLE_LARGE_TRIGGER_TOKENS
  ) {
    return { fire: true, reason: 'idle-large' };
  }

  return { fire: false };
}

// ─── runCompaction ─────────────────────────────────────────────────────

const RESPONSES_COMPACT_URL = 'https://api.openai.com/v1/responses/compact';
const COMPACTION_MODEL = 'gpt-5';

export interface CompactionUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  /** Future-proof: forward any extra usage fields the API ships. */
  [key: string]: unknown;
}

export interface CompactionResult {
  /** New `response.id` after compaction. `null` if the endpoint was a noop. */
  newResponseId: string | null;
  /** Usage payload from the compaction call, if returned. */
  usage: CompactionUsage | null;
  /** True if the SDK / endpoint reported success. */
  ok: boolean;
  /** Set when we fell back / no-op'd; a hint for the caller's log line. */
  fallback?: 'sdk-missing' | 'endpoint-missing' | 'request-failed';
  /** Human-readable detail for diagnostic logging. */
  detail?: string;
}

/**
 * Loose duck-typed shape for the OpenAI SDK's `responses.compact` method.
 * The runtime check below probes for this shape; the static type is
 * deliberately permissive so older SDK versions still compile.
 */
interface CompactionCapableSDK {
  responses?: {
    compact?: (params: {
      model: string;
      previous_response_id: string;
      store?: boolean;
    }) => Promise<{
      id?: string;
      usage?: CompactionUsage;
      [key: string]: unknown;
    }>;
  };
  apiKey?: string;
}

/**
 * Execute a compaction round-trip. Returns the new response id (the
 * planner uses it as the next `previous_response_id`) plus usage stats.
 *
 * Fallback chain:
 *   1. `client.responses.compact(...)` — preferred (SDK type-safe).
 *   2. Direct fetch against `/v1/responses/compact` — handles SDK lag.
 *   3. No-op with `ok: false, fallback: 'endpoint-missing'` — safety net
 *      already covered by `context_management` on every `responses.create`.
 *
 * NEVER throws — every failure surface returns a structured result. The
 * planner uses `result.ok` to decide whether to advance the chain.
 */
export async function runCompaction(
  client: OpenAI,
  lastResponseId: string,
): Promise<CompactionResult> {
  if (!lastResponseId || typeof lastResponseId !== 'string') {
    return {
      newResponseId: null,
      usage: null,
      ok: false,
      fallback: 'request-failed',
      detail: 'lastResponseId missing',
    };
  }

  // 1. Try the SDK first if the method exists. The Feb 2026 compaction API
  //    landed mid-flight; older SDK versions don't carry the typing.
  const sdk = client as unknown as CompactionCapableSDK;
  const compactFn = sdk.responses?.compact;
  if (typeof compactFn === 'function') {
    try {
      const resp = await compactFn.call(sdk.responses, {
        model: COMPACTION_MODEL,
        previous_response_id: lastResponseId,
        store: false,
      });
      return {
        newResponseId:
          typeof resp?.id === 'string' && resp.id.length > 0 ? resp.id : null,
        usage: (resp?.usage as CompactionUsage | undefined) ?? null,
        ok: true,
      };
    } catch (err) {
      // Fall through to the fetch fallback — the SDK may have shipped the
      // type but the runtime endpoint may still be inaccessible.
      console.warn(
        '[compaction-runner] SDK responses.compact failed; trying fetch fallback',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 2. Fetch fallback. Uses the same env-var auth path as the planner.
  const apiKey = process.env.OPENAI_API_KEY ?? sdk.apiKey;
  if (!apiKey || typeof apiKey !== 'string') {
    return {
      newResponseId: null,
      usage: null,
      ok: false,
      fallback: 'request-failed',
      detail: 'OPENAI_API_KEY missing',
    };
  }

  try {
    const resp = await fetch(RESPONSES_COMPACT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: COMPACTION_MODEL,
        previous_response_id: lastResponseId,
        store: false,
      }),
    });

    if (resp.status === 404) {
      console.warn(
        '[compaction-runner] /v1/responses/compact returned 404 — endpoint not available on this account; relying on context_management safety net',
      );
      return {
        newResponseId: null,
        usage: null,
        ok: false,
        fallback: 'endpoint-missing',
        detail: '404 from /v1/responses/compact',
      };
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '<no body>');
      return {
        newResponseId: null,
        usage: null,
        ok: false,
        fallback: 'request-failed',
        detail: `${resp.status}: ${errText.slice(0, 240)}`,
      };
    }

    const json = (await resp.json().catch(() => null)) as {
      id?: string;
      usage?: CompactionUsage;
    } | null;
    return {
      newResponseId:
        typeof json?.id === 'string' && json.id.length > 0 ? json.id : null,
      usage: json?.usage ?? null,
      ok: true,
    };
  } catch (err) {
    return {
      newResponseId: null,
      usage: null,
      ok: false,
      fallback: 'request-failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
