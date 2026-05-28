# Review C — State + Persistence

> Reviewer: independent sonnet agent (Reviewer C). Date: 2026-05-27.

---

## Summary

The state types in `shared/state.ts` are substantially richer than what `docs/contracts.md` § 2 describes — field names, required fields, and the entire `AgentStatus` / `AgentRole` vocabulary have all diverged. The code is the evolved, more correct version; contracts.md is the stale one. The good news is that the code is internally consistent: tool-router, store, sim, ipcSync, and side-store all use the same `state.ts` types. The bad news is three integration gaps that are actively unfired: `update_harness` never calls `appendHarnessRule` or `appendDecision`, `dispatch_agent_mock` never calls `writeAgent`, and `handleRenderCanvas` never calls `setLastCanvas` — all three are documented in contracts.md § 14 as required wiring.

---

## Findings

### BLOCKERS

**B1 — `update_harness` does not persist to disk**

`tool-router.ts` `handleUpdateHarness` calls `sendStripPatch('harness', ...)` and `renderCanvas(flashPayload)` but never calls `appendHarnessRule(rule)` or `appendDecision(...)`. Contracts.md § 14 mandates both. Because `addHarnessRule` in the store is also wired (correctly) in `ipcSync.ts` to apply the patch, the renderer store is correct — but on app restart, all harness rules are lost. The planner's `readWorldState()` will return an empty `harness` array, making the entire "accumulated context survives rotation" design moot.

**B2 — `dispatch_agent_mock` does not persist agents to disk**

`handleDispatchAgentMock` adds the agent to the renderer store via `sendStripPatch` but never calls `writeAgent(agent)` or `appendDecision(...)`. § 14 mandates both. An app restart or session-rotation reseed will show zero agents in the world-state even though agents were dispatched. Combined with B1 this means `readWorldState()` always returns a hollow context.

**B3 — `handleRenderCanvas` does not call `setLastCanvas`**

§ 14 mandates `setLastCanvas(args.component, args.props)` after any canvas render so the planner can reason about the last shown surface. It is missing entirely. The `lastCanvas` field in `WorldState` will always be `null`.

---

### MAJOR

**M1 — `ToolCallResponse` shape mismatch between contracts.md and code**

contracts.md § 3.1 defines:
```ts
interface ToolCallResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}
```
The actual `ipc.ts` and every tool handler returns:
```ts
{ ok: true; callId: string; output: unknown; latencyMs: number }
| { ok: false; callId: string; error: string; latencyMs: number }
```
The code shape is better (typed discriminant union, includes `callId` for correlation, `latencyMs` for observability). But any consumer still referencing the contracts.md shape will break. The `IpcInvokeMap[ToolCall]` correctly declares the real shape. This is a contracts drift that must be closed with a `docs(contracts): change ToolCallResponse` commit.

**M2 — `ask_user` handler fires `AskShow` AFTER setting up the timeout race — window closed race**

In `handleAskUser`, `ctx.pendingAsks.set(askId, settle)` and `setTimeout(...ASK_TIMEOUT_MS)` are set up inside the `new Promise` body, and only then does `w.webContents.send(AskShow, ...)` fire. However, `settle('timeout')` is called immediately if there is no window. The problem: if `w.isDestroyed()` becomes true between the `const w = ctx.stripWindow` assignment and the `w.webContents.send(...)` call (window crashes mid-handler), `send` will throw, which propagates up and is swallowed by the outer `try/catch` in `routeToolCall` — but `settle` has already been called with `'timeout'`, so the promise does resolve. The actual response returned will say `ok: true` with `answer: 'timeout'` rather than `ok: false`. This is arguably correct behavior but worth documenting.

**M3 — `IpcSendMap` missing the new append-only channels**

`IpcSendMap` and `IpcInvokeMap` in `ipc.ts` do not include `PlannerConsult`, `PlannerReasoningDelta`, `CodexEvent`, `CodexDispatch`, or `CodexAbort`. The channels exist in the enum (correctly below the append-only marker), but the typed map entries are absent. Any typed dispatch helper that tries to use `IpcSendMap[IpcChannel.CodexEvent]` will get `undefined` instead of a concrete payload type. This is not a crash but defeats the point of the typed map.

**M4 — `SidestoreSnapshot` response type mismatch between `IpcInvokeMap` and `SidestoreSnapshotResponse`**

`IpcInvokeMap[SidestoreSnapshot]` declares response as `{ ok: true; world: Record<string, unknown> } | { ok: false; error: string }`. The exported `SidestoreSnapshotResponse` type (bottom of `side-store.ts`) is `{ ok: true; world: WorldState } | ...`. The actual IPC handler returns a `WorldState` but the typed map promises a weaker `Record<string, unknown>`. Any renderer code invoking this channel through the typed map loses the concrete `WorldState` shape.

**M5 — `flushAgentWrites` does not actually flush; it only cancels pending timers**

`flushAgentWrites()` clears and drains all pending timers but does NOT call `writeAgent(frozen)` for each pending agent before clearing them. The comment says "Flush any pending debounced agent writes immediately" and docs/contracts.md § 14 (Shutdown) says "so any pending debounced agent writes hit disk before the process exits." The current implementation silently discards those writes instead of flushing them. On fast exits during active demo, the last 100ms of agent state is lost.

---

### MINOR

**m1 — `ToolName` enum in `ipc.ts` includes names not in contracts.md § 4**

`ToolName` includes `dispatch_agent`, `record_decision`, `read_world_state`, `canvas_response`, `dismiss_canvas` — none of which have handler entries in `tool-router.ts`. They fall through to `unknown_tool`. This is forward-looking scaffolding but will silently return errors if the Realtime session ever emits them. The contracts.md § 3.1 `ToolName` union only lists the five currently implemented tools.

**m2 — `handleAskUser` silently resolves with `{ok:true, answer:'timeout'}` — never returns `ok:false`**

The spec says `ask_user` returns `{ answer: string }` where `"timeout"` is the answer text. So this is spec-compliant. But if a caller expects any `ok:false` path to signal "could not ask user" (e.g., no strip window), they will silently receive a confusing successful timeout. A distinct `ok:false` for the no-window case would be safer.

**m3 — `ipcSync` `handleAsk` is a stub that does nothing**

`handleAsk` logs the payload then calls `void payload`. There is no actual UI surfacing, no auto-answer logic, and no path that calls `bridge.ask.answer(...)`. The comment explains this is intentional for the demo (the user or dev key R will resolve Jin), but in a clean boot without the sim running, `ask_user` calls will timeout silently after 60s with no user feedback.

**m4 — `atomicWrite` has a same-path concurrent-write race**

If two concurrent callers write to the same path (e.g., two rapid harness updates), both will write to `${path}.tmp` and then race on `fs.rename`. The rename is atomic at the OS level so no corruption occurs, but one write silently wins and the other is lost. For harness this is avoided because `appendHarnessRule` is `async` and callers await it (once B1 is fixed and the wiring is added). But `queueAgentWrite` fires independently per agent — if the same agent queues twice before the first timer fires, the shared `.tmp` file is overwritten before the first rename, and both renames succeed (idempotent for the winner). This is actually safe for the debounced case, but the non-debounced `writeAgent` called concurrently for the same agent is not protected.

**m5 — `AgentStatus` contract gap: `'spawning'` and `'thinking'` and `'killed'` absent from contracts.md**

contracts.md § 2.1 declares `AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'error'`. The code has `'spawning' | 'working' | 'blocked' | 'thinking' | 'done' | 'error' | 'killed'`. The `HIVE_RANK` table in `selectors.ts` relies on `spawning`, `thinking`, and `killed`. If any consumer reads the contracts doc for valid status values they will omit these.

**m6 — `appendNarration` in sim constructs `TranscriptItem` without `id` being present in contracts.md**

The sim constructs transcript items with `id`, `role`, `content`, `phase`, `timestamp`. The code's `TranscriptItem` requires `id` (correct, per `state.ts`). contracts.md § 2.5 does not include `id` at all, and uses `text` not `content`. Both the code and the real type are correct; the spec is stale.

---

## Type drift table

| Type | contracts.md says | state.ts has | Consumer impact |
|---|---|---|---|
| `Agent.accent` | `accent: string` | `accentColor: \`#${string}\`` | tool-router, sim both use `accentColor` — code is self-consistent; contracts stale |
| `Agent.trail` | `trail: string` (flat) | `currentTask: string \| null` + `taskTrail: string[]` | contracts stale; all consumers use `currentTask`/`taskTrail` correctly |
| `Agent.files` | `files: string[]` | `recentFiles: string[]` | contracts stale; all consumers use `recentFiles` correctly |
| `Agent.startedAt` | `startedAt?: number` | `dispatchedAt: number` (required) + `finishedAt: number \| null` | contracts stale; `selectors.ts` sorts by `dispatchedAt` correctly |
| `Agent.status` | `'idle'\|'working'\|'blocked'\|'done'\|'error'` | adds `'spawning'\|'thinking'\|'killed'` | contracts missing three valid statuses; HIVE_RANK uses them |
| `Agent.role` | lowercase `'frontend'\|'backend'\|'data'\|'design'` | `'Frontend'\|'Backend'\|'Data'\|'Design'\|string` | tool-router `capitalizeRole()` converts; sim hardcodes title-case — both correct to code shape |
| `HarnessRule` | `{ rule, why, timestamp }` | adds required `id`, `scope`, `source` | contracts missing 3 required fields; any code following contracts schema will fail type-check |
| `TranscriptItem.text` | `text: string` | `content: string` | contracts use wrong field name; any consumer using `item.text` gets `undefined` at runtime |
| `TranscriptItem.id` | absent | `id: string` (required) | contracts missing required field |
| `StripState.connecting` | `{ kind: 'connecting' }` (no extra fields) | `{ kind: 'connecting'; attempt: number; since: number }` | contracts stale; store/sim use `attempt`/`since` |
| `StripState.error` | `{ kind: 'error'; message: string }` | adds `code`, `recoverable`, `since` | contracts missing three fields used by `setError` action |
| `StripState.disconnected` | `{ kind: 'disconnected' }` | adds `reason`, `since` | contracts stale |
| `ToolCallResponse` | `{ ok, result?, error? }` | `{ ok, callId, output, latencyMs }` | see M1 — significant shape change |

---

## Architectural concerns

**Persistence integration is spec'd but not wired.** The entire side-store is implemented correctly in isolation, and the contract (§ 14) precisely describes where each call should happen. But the wiring — B1, B2, B3 — was left for "R3 review" (per § 14: "Wiring happens at R3 review — Main does the cross-cutting integration"). That review has not happened. Until those three call sites are added to `tool-router.ts`, the side-store is a well-built library that nothing calls.

**`ipcSync` `startSim` action bypasses the canvas flash double-trigger.** When `addAgent` fires via IPC patch, `commands.addAgent` in the store already auto-transitions to `hive` state and calls `enterHive`. Then `startSim` is fired as a separate patch, which calls `startMixtapeDemo`, which calls `commands.enterHive` again (inside the `T+0` timer). The second `enterHive` is legal from `hive` state, so no guard fires, but it resets `activeAgentId` and `since`. This is benign but noisy.

---

## What's working well

- **Type internal consistency is excellent.** Despite significant divergence from contracts.md, the code is self-consistent across all six files. tool-router constructs `Agent` objects with exactly the fields `state.ts` requires; sim's `planToCanonical` hits every required field; ipcSync's `AddAgentPatch` matches the store's `addAgent` signature; selectors correctly reference `dispatchedAt`, `taskTrail`, `recentFiles`.

- **`atomicWrite` + JSONL `atomicAppendLine` are solid.** The `open + appendFile + sync + close` pattern is correct. The `.tmp`-then-rename atomic write is correct. `readJsonlSafely` handles parse errors per-line without poisoning the whole file.

- **Legal-transition guards are thorough.** Every state action in the store guards against illegal source states and no-ops with a dev-mode warning. The `recoverFromError` and `reconnect` guards are correctly restrictive.

- **`flushAgentWrites` is called at the right lifecycle point** (contracts.md § 14 Shutdown) — the wiring intention is correct even if the implementation body is wrong (see M5).

- **Append-only marker in `ipc.ts` is respected.** All new channels (`PlannerConsult`, `PlannerReasoningDelta`, `SidestoreSnapshot`, `CodexEvent`, `CodexDispatch`, `CodexAbort`) are below the marker with correct attribution comments. Nothing above the marker was modified.
