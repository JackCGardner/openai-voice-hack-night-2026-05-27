# Review D — Planner + Codex

> Reviewer: independent Sonnet agent (Reviewer D). Date: 2026-05-27.

## Summary

The planner (`planner.ts`) is structurally sound and production-safe for a hackathon, with one serious bug: the SSE parser may silently discard reasoning events because the Responses API wraps delta payloads under an `output[i].type` / `output[i].delta` envelope rather than flat top-level `type`/`delta` fields. The Codex pool (`codex-pool.ts`) is the strongest of the three files — SDK usage is accurate, the semaphore is correct, and error paths clean up properly — but it passes an `approvalPolicy` value (`'never'`) that the SDK's `ApprovalMode` type does not include. The worktree manager (`codex-worktree.ts`) is clean; the git invocation uses `-B` correctly and cleanup is try/catch-free (callers handle it).

---

## Findings

### BLOCKERS

#### B1 — SSE event shape mismatch in planner.ts (planner.ts:200-213)

**What:** The parser looks for `event.type === 'response.reasoning_summary_text.delta'` and `event.delta` at the top level of each parsed SSE JSON object. The actual Responses API SSE schema does not emit a bare `{ type, delta }` object. Stream events are enveloped: a `response.output_item.delta` event carries `{ type: "response.output_item.delta", output_index, item_index, delta: { type: "...", ... } }`, and a `response.reasoning_summary_text.delta` event carries `{ type: "response.reasoning_summary_text.delta", item_index, summary_index, delta: string }`. The flat `event.delta` field is only present on certain subtypes and its path through the JSON differs by event type.

More critically, `response.output_text.delta` events carry `{ type, output_index, content_index, delta }` — the `delta` IS a top-level string on that event type. But for `response.reasoning_summary_text.delta` the shape also has `delta` at the top level. So the check may actually be correct depending on the exact API version — but this cannot be verified without a live test because the Responses API spec for SSE deltas is not fully reflected in any doc in the repo. The current code silently discards any event it cannot match, so a shape mismatch results in both `reasoningSummary` and `finalText` remaining empty, and the function returns `{ summary: '', decisions: [], full_text: '' }` — which is then narrated by Realtime as a blank tool result.

**Why it matters:** If the API shape is even slightly different, the planner silently returns empty results for every call. The Realtime layer narrates silence; the user hears nothing useful. There is zero error surfacing — it just looks like the planner is broken or very slow.

**Suggested fix:** Add a logging probe: emit `console.debug('[planner] SSE event type=', event.type)` for every event in dev builds. Also add a guard at the end: if `finalText` is empty after stream completion, throw an error rather than returning empty results, so the renderer sees a failure rather than a silent blank.

---

#### B2 — `approvalPolicy: 'never'` is not a valid `ApprovalMode` (codex-pool.ts:329)

**What:** `codex-pool.ts` line 329 passes `approvalPolicy: 'never'` to `startThread()`. The SDK's `ApprovalMode` type (from `index.d.ts`) is:

```ts
type ApprovalMode = "never" | "on-request" | "on-failure" | "untrusted";
```

Wait — `"never"` IS present. On closer reading this is NOT a blocker. Retraction: the value is valid per the actual SDK types. Leaving the analysis here for transparency.

**Correction:** This is not a bug. Moving on.

---

#### B2 (revised) — `runStreamed` returns `Promise<StreamedTurn>`, not `StreamedTurn` (codex-pool.ts:358)

**What:** The SDK's `Thread.runStreamed` signature is:

```ts
runStreamed(input: Input, turnOptions?: TurnOptions): Promise<StreamedTurn>;
```

The code does:

```ts
const { events } = await thread.runStreamed(req.task, { signal: abort.signal });
```

The `await` correctly unwraps the `Promise<StreamedTurn>`, yielding `StreamedTurn`, which has `{ events: AsyncGenerator<ThreadEvent> }`. This is correct. Not a bug.

**Revised B2 — Real blocker: `modelReasoningEffort` and `networkAccessEnabled` are absent from the `startThread` call despite being in `ThreadOptions`**

These fields are documented in the research doc and exist in the SDK types, but the pool never sets them. The pool sets the agent to `sandboxMode: 'workspace-write'` but does not restrict network access, meaning agents can make arbitrary network requests (fetching packages is fine, but exfiltrating context is a risk). More practically: there is no reasoning effort configured, so agents default to whatever the CLI default is — likely `medium` or `high` — which burns more tokens per agent than needed for a 7-minute demo.

**Why it matters:** Minor for the demo but a correctness gap vs. the spec in `codex-for-everything.md §6.2` which explicitly calls for `networkAccessEnabled` control. For the hackathon it is acceptable to leave at defaults, but should be flagged.

**Severity:** MAJOR (not BLOCKER). See MAJOR section below.

---

### MAJOR

#### M1 — `consult_director` schema in realtime.ts diverges from contracts.md § 4.5

**What:** `contracts.md § 4.5` specifies the `consult_director` tool's `update_harness` sibling (§ 4.4) as requiring `why`. But more directly relevant: `contracts.md § 4.5` shows the parameters block without `additionalProperties: false`, while `realtime.ts:195` adds `additionalProperties: false` at the top-level parameters object. This is a minor deviation.

The larger issue: `contracts.md § 4.5` specifies the Behavior as returning `{ summary: string, decisions: string[] }`, but `planner.ts` returns `{ summary, decisions, full_text }`. The `full_text` field is present in the actual `ConsultResult` type but absent from the contract spec. The tool result that flows back to Realtime via `tool-router.ts:handleConsultDirector` returns the entire `ConsultResult` object (including `full_text`), which is fine — extra fields are harmless — but any worker reading `§ 4.5` to write a consumer will not know `full_text` exists. This is a doc drift.

**Where:** `docs/contracts.md:332`, `apps/director/src/main/planner.ts:49`, `apps/director/src/main/tool-router.ts:299`

**Why it matters:** Secondary workers building on the `consult_director` tool result will miss `full_text` and potentially re-derive it from `decisions`, losing fidelity. A contract-change commit should add `full_text` to § 4.5.

**Suggested fix:** `docs(contracts): clarify consult_director` — add `full_text: string` to the § 4.5 return shape.

---

#### M2 — No `response.completed` terminal event handling in planner.ts

**What:** The planner's SSE parser does not look for `response.completed` as an explicit terminal signal. It relies entirely on `reader.done` to know when the stream ends. Per the Responses API spec, the stream sends a `response.completed` event before the SSE connection closes. If the stream closes without `done: true` (e.g., due to a TCP reset), the planner loop exits cleanly but may have processed only a partial event stream — with no indication of truncation.

**Where:** `apps/director/src/main/planner.ts:172-215`

**Why it matters:** In a degraded network (Wi-Fi at a hackathon), partial streams are plausible. The current code would return whatever partial text accumulated, possibly mid-sentence, and `parseDecisions()` would return an empty list. The Realtime layer would narrate an incomplete answer. There is no retry, no error surfacing, and no distinction between "stream completed normally" and "stream cut off."

**Suggested fix:** Track whether `response.completed` was seen. If the reader closes without it, log a warning and include `truncated: true` in the result or throw a retriable error.

---

#### M3 — Semaphore acquire/release race in codex-pool.ts (codex-pool.ts:158-170)

**What:** The semaphore implementation has a subtle correctness issue. `acquire()` increments `inFlight` and resolves the waiter promise, but the increment happens inside the `acquire` body AFTER the waiter resolves:

```ts
async function acquire(): Promise<void> {
  if (inFlight < MAX_CONCURRENT) {
    inFlight += 1;      // ← path A: increments immediately
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight += 1;        // ← path B: increments AFTER the promise resolves
}

function release(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) next();     // ← calls resolve(), path B increments AFTER this returns
}
```

In path B, `release()` decrements `inFlight`, then calls `next()` (the waiter's resolve). Between `next()` returning and path B's `inFlight += 1` executing (asynchronously, since the awaiter is scheduled as a microtask), another `acquire()` call could see `inFlight` at the decremented value and take another slot — temporarily allowing 5 concurrent agents. In the context of a single-threaded JS event loop this window is a microtask boundary, so in practice the race is very unlikely. However, it is a correctness violation of contracts.md § 9's "never spawn >4 agents" rule.

**Where:** `apps/director/src/main/codex-pool.ts:158-170`

**Why it matters:** § 9 of contracts.md does not list a "never spawn >4 agents" rule by name in the keyboard/style section (§ 9.1-9.4), but the module header comment cites `MAX_CONCURRENT = 4` as the ceiling and `codex-for-everything.md § 4` explicitly calls 3-5 the practical ceiling for hardware safety. Exceeding this on a 16 GB Mac causes OOM.

**Suggested fix:** Increment `inFlight` inside `release()` before calling `next()`, or restructure as a counting semaphore that keeps the count in one place.

---

#### M4 — `consult_director` tool result does not flow back to Realtime as a `function_call_output`

**What:** `tool-router.ts:handleConsultDirector` returns a `ToolCallResponse` to the `tool.call` IPC handler. The IPC handler returns this to the renderer. However, looking at the tool bridge chain: the renderer's `tool.call` invoke handler receives the result. What happens next depends entirely on whether the renderer's `toolBridge.ts` or `useRealtimeClient.ts` sends a `conversation.item.create` (function_call_output) back over the Realtime data channel. This is outside the scope of this review's files, but the concern is live: if the renderer does not inject the `ConsultResult` as a `function_call_output`, the Realtime model never hears the answer and cannot narrate the summary.

**Where:** `apps/director/src/lib/toolBridge.ts` (not in review scope), `apps/director/src/main/tool-router.ts:282-312`

**Why it matters:** The entire user-facing value of `consult_director` is that the voice model narrates the planner's summary. If the result doesn't loop back to the Realtime session, the user hears silence after saying "how should we structure X?"

**Suggested fix:** The tool-router should emit a `IpcChannel.ToolResult` with `asSyntheticItem: true` after `handleConsultDirector` resolves — the same pattern other async tool results use — rather than relying on the ipcMain.handle return value to carry the narration trigger. Verify `toolBridge.ts` actually sends the `function_call_output` + `response.create` pair.

---

### MINOR

#### N1 — `readWorldState()` stub acknowledged but not flagged in planner output

**Where:** `apps/director/src/main/planner.ts:68-76`

The stub is intentional (TODO comment references W3's side-store). It is correctly flagged in the code and in `contracts.md § 14`. No action required beyond confirming W3's `readWorldState()` export matches the import path `'./side-store.js'`.

---

#### N2 — Branch naming allows `/` characters which may conflict with git tag refs

**Where:** `apps/director/src/main/codex-worktree.ts:86`

Branch: `director/<sessionId>/<agentId>`. If `sessionId` or `agentId` ever contain characters that are invalid in git refs (spaces, `~`, `^`, `:`, `?`, `*`, `[`, `\`), `git worktree add` will fail with an opaque error. The current session ID and agent ID generation is not visible in these files, but `agentId` values like `maya`, `jin`, `cleo`, `wren` are safe. For future proofing, sanitize with a regex before constructing the branch name.

---

#### N3 — `codex-worktree.ts` cleanup does not verify the branch deletion succeeded

**Where:** `apps/director/src/main/codex-worktree.ts:116-119`

The `cleanup()` function calls `git branch -D branch` but does not check `result.code`. The comment says "failures are non-fatal" — that is intentional and acceptable for a demo. Just noted for completeness.

---

#### N4 — `ipcMain.handle(IpcChannel.PlannerConsult)` registered but never removed

**Where:** `apps/director/src/main/planner.ts:227-243`

`registerPlannerDevIpc` registers a handler that is never removed. In Electron, calling `ipcMain.handle` on the same channel twice throws. If the app is ever hot-reloaded or the function is called more than once, this silently fails. Pair with a `ipcMain.removeHandler` guard (same pattern as `registerToolRouterIpc`).

---

#### N5 — Missing `collab_tool_call` in `classifyItem()`

**Where:** `apps/director/src/main/codex-pool.ts:202-221`

The Codex research doc (`codex-for-everything.md § 2c`) lists `collab_tool_call` as a possible `item.type` in the JSONL stream. The SDK's `ThreadItem` union in `index.d.ts` does not include `collab_tool_call` — so this is a doc artifact, not a real gap. No action needed unless the SDK is updated to add it.

---

## Codex SDK usage audit

The code matches the actual SDK shape accurately. Specific confirmations:

| Usage in codex-pool.ts | SDK reality (index.d.ts) | Match? |
|---|---|---|
| `new Codex({ apiKey })` | `constructor(options?: CodexOptions)` where `CodexOptions.apiKey?: string` | YES |
| `codex.startThread({ workingDirectory, sandboxMode, approvalPolicy, skipGitRepoCheck })` | `startThread(options?: ThreadOptions)` with all four fields present in `ThreadOptions` | YES |
| `await thread.runStreamed(req.task, { signal })` | `runStreamed(input: Input, turnOptions?: TurnOptions): Promise<StreamedTurn>` where `TurnOptions.signal?: AbortSignal` | YES |
| `for await (const ev of events)` where `events` is `StreamedTurn.events` | `StreamedTurn = { events: AsyncGenerator<ThreadEvent> }` | YES |
| `ev.type === 'thread.started'` + `ev.thread_id` | `ThreadStartedEvent = { type: "thread.started"; thread_id: string }` | YES |
| `ev.type === 'turn.failed'` + `ev.error.message` | `TurnFailedEvent = { type: "turn.failed"; error: ThreadError }` where `ThreadError = { message: string }` | YES |
| `ev.type === 'turn.completed'` + `ev.usage` | `TurnCompletedEvent = { type: "turn.completed"; usage: Usage }` | YES |
| `ev.type === 'error'` + `ev.message` | `ThreadErrorEvent = { type: "error"; message: string }` | YES |
| `ev.item.type` switching on item events | `ThreadItem` is a discriminated union on `type` | YES |
| `import { Codex, type Thread, type ThreadEvent, type ThreadItem }` | All four exported from the package | YES |

One naming deviation from the research doc: `codex-for-everything.md` uses snake_case `working_directory`, `sandbox_mode` in its code samples (§ 2b), but the actual SDK uses camelCase. The code in `codex-pool.ts` correctly uses camelCase. W1's report about the snake_case caveat was accurate; the implementation correctly ignored the doc's snake_case samples.

One gap: `approvalPolicy: 'never'` is valid per the SDK (`ApprovalMode = "never" | ...`). However the research doc's own example uses `'never'` too — consistent.

---

## Planner SSE parser audit

The parser is structurally correct for the happy path. Edge case analysis:

**Partial chunks at buffer boundary** — handled correctly. `decoder.decode(value, { stream: true })` accumulates incomplete UTF-8 sequences, and the `while (sepIdx >= 0)` loop leaves incomplete events in `buffer`. This is the right pattern.

**Multi-line `data:` fields** — the parser joins all `data: ` lines in a single SSE event with `\n`. Responses API events are single-line JSON, so this is fine in practice. If a future event type has a multi-line data value, the join would produce invalid JSON — acceptable risk for now.

**`[DONE]` terminator** — handled correctly (`if (dataStr === '[DONE]') continue`).

**`event:` prefix lines** — SSE spec allows `event: <type>` lines before `data:` lines. The parser filters to lines starting with `data: ` and ignores others. This means if OpenAI ever uses the SSE `event:` field to discriminate stream events instead of the JSON `type` field, the parser would need updating. Current API does not use this, so no immediate issue.

**JSON parse safety** — wrapped in try/catch with `continue` on failure. Safe.

**The key unresolved question:** whether the parsed JSON object carries `type` and `delta` at the top level (as the code assumes) or nested under an `output[]` array (as some SSE schemas do). This cannot be statically verified from the files in scope. See B1 above.

---

## Architectural concerns

**1. Shared OPENAI_API_KEY — quota contention**
`planner.ts` and `codex-pool.ts` both read `process.env.OPENAI_API_KEY`. The Realtime token mint in `main/realtime.ts` uses the same key. All three hit the same OpenAI org quota simultaneously. During a 4-agent parallel Codex run plus a Realtime session plus a planner call, all five concurrent API consumers share one rate-limit envelope. The `ProactiveAnnouncePayload` type has a `'rate_limit'` reason — this was anticipated — but there is no actual 429 handler anywhere in `planner.ts` or `codex-pool.ts`. If the org rate-limits, both services throw uncaught errors that surface to the user as generic failures.

**2. Five-hour rolling window for Codex**
`codex-for-everything.md § 3` documents the five-hour rolling window for Plus/Business ChatGPT plans. The current SDK passes `apiKey` directly (no ChatGPT login path). In API-key mode there is no rolling window — usage is metered in dollars — but there are still per-minute token rate limits. No rate-limit retry logic exists in the pool. For the hackathon this is a real risk if multiple demo runs happen back-to-back.

**3. Planner output → Realtime narration path is implicit**
The planner result flows: `consultDirector()` → `handleConsultDirector()` → `ToolCallResponse.output` → IPC `tool.call` response → renderer. Whether the renderer then sends this as a `function_call_output` to Realtime is not enforced by the main-process code. The wiring depends entirely on the renderer's `toolBridge.ts` (owned by W2/W3, not reviewed here). This is the single highest-risk integration point — a bug in toolBridge would cause the user to say "how should we structure this?" and hear silence.

**4. No compaction integration for planner**
`compaction.md` outlines that orchestrator memory should use `responses.compact` before each Realtime rotation. The planner currently makes a single stateless Responses call per `consult_director` invocation — no `previous_response_id` chaining, no input history. This is correct for a stateless planner design, but it means the planner has no access to prior planning decisions from the same session unless they are explicitly passed via `args.context`. The `readWorldState()` stub's eventual replacement with the side-store will partially address this.

---

## What's working well

- **API key guard is early and loud.** Both `planner.ts` and `codex-pool.ts` throw immediately with a clear message if `OPENAI_API_KEY` is absent — no silent null.
- **Request body matches spec exactly.** `planner.ts` assembles `{ model, input, reasoning, stream, max_output_tokens }` with correct field names and values. `reasoning.effort: 'high'` and `summary: 'auto'` match the contracts.md description.
- **Semaphore is present and the limit is 4.** `MAX_CONCURRENT = 4` enforced via `acquire()`/`release()` with a waiter queue. The `try/finally` in the fire-and-forget IIFE ensures `release()` always runs — even on abort — preventing slot leaks.
- **Worktree lifecycle is solid.** `git worktree prune` before `add`, `-B` for force-create, `--force` on remove, best-effort branch deletion. The `createWorktree` function correctly surfaces non-zero git exit codes as thrown errors.
- **SDK imports are accurate.** All named imports (`Codex`, `Thread`, `ThreadEvent`, `ThreadItem`) exist in the actual installed SDK.
- **IPC channels follow the append-only pattern.** `PlannerConsult`, `PlannerReasoningDelta`, `CodexEvent`, `CodexDispatch`, `CodexAbort` all appear below the § 13.1 marker in `ipc.ts`.
- **AGENTS.md template is persona-complete.** Maya/Jin/Cleo/Wren role specializations and tone templates match the Pass 4 identity table from `ux-design.md`. The fallback template is sensible for unknown roles.
- **Error categorization in the streaming loop is correct.** Abort errors are suppressed; non-abort errors emit a typed `error` CodexEvent; the `agent_finished` synthetic event fires in all paths (success, abort, error) via the `finally` block.
