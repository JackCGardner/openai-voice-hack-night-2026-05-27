# OpenAI Compaction — Research Notes for Director

Compiled 2026-05-27 from `developers.openai.com/api/docs/guides/compaction`, `developers.openai.com/api/reference/resources/responses/methods/compact`, `developers.openai.com/api/docs/guides/conversation-state`, the `developers.openai.com/blog/skills-shell-tips` post on long-running agents, and two OpenAI developer-community threads ([1372502](https://community.openai.com/t/compact-a-response-with-previous-response-id/1372502), [1378730](https://community.openai.com/t/compact-a-response-with-conversations-api/1378730)) that surface real implementation gotchas.

---

## 0. TL;DR

Compaction is a Responses-API-native mechanism (shipped Feb 2026) that replaces the *assistant-side history* of a long conversation — assistant messages, tool calls, tool results, **and encrypted reasoning items** — with a single **opaque encrypted "compaction item"** that future requests can carry forward. User messages are kept verbatim. There are two modes: **server-side** (declarative — set a token threshold and the server compacts mid-stream) and **standalone** (`POST /responses/compact` — explicit endpoint, fully stateless, ZDR-friendly). The compaction item is **not human-interpretable**, which is the load-bearing fact for Director: we cannot inspect what was summarized, only trust that the model will use it on the next turn. Supported on `gpt-5.3-codex`, `gpt-5.5`, `gpt-5.4`, and listed alongside many other modern models.

→ **Implication for Director**: compaction is the right primitive for the `gpt-5.5` orchestrator's long memory, but because the compacted blob is opaque, we **cannot rely on compaction alone to preserve load-bearing decisions** (Harness rules, user-issued constraints). We need a parallel "Decision Ledger" that survives outside compaction.

---

## 1. What compaction is

Compaction is a built-in capability of the Responses API that compresses an in-progress conversation into a shorter token-equivalent payload while preserving "key prior state and reasoning." The output is an **encrypted compaction item** — a structured opaque object that future `client.responses.create(...)` calls carry forward in their `input` array (or that `previous_response_id` chains pull in implicitly).

OpenAI's own framing (from the Shell + Skills blog post): *"Use compaction as a **default long-run primitive, not an emergency fallback.**"* This is significant: it's positioned as a routine part of the loop, not a panic button.

**Two API surfaces:**

**a) Server-side, in-stream** — pass `context_management` on `responses.create`:

```python
response = client.responses.create(
    model="gpt-5.3-codex",
    input=conversation,
    store=False,
    context_management=[{"type": "compaction", "compact_threshold": 200000}],
)
conversation.extend(response.output)  # includes the compaction item
```

When the *rendered* token count crosses `compact_threshold` mid-stream, the server "triggers a compaction pass, emits a compaction output item in the same stream, and prunes context before continuing inference." The compaction item appears as one of the entries in `response.output`.

**b) Standalone endpoint** — `POST /responses/compact`:

```python
compacted = client.responses.compact(
    model="gpt-5.5",
    input=long_input_items_array,
)
next_input = [
    *compacted.output,
    {"type": "message", "role": "user", "content": user_input_message()},
]
```

The standalone endpoint is **stateless**: send the full window in, get the compacted window back. It can also be used with a `previous_response_id` (subject to the *"cannot be used in conjunction with `conversation`"* constraint).

→ **Implication for Director**: we want the standalone endpoint, not server-side auto-compaction. Reason: server-side fires *during* an in-flight response, which is bad when the orchestrator is mid-tool-orchestration and needs to react to it. Standalone gives us a quiescent moment — between user turns, or between batches of tool calls — to compact deliberately.

---

## 2. When it triggers

- **Server-side mode**: automatic, threshold-based on `compact_threshold` (token count). The threshold is per-`responses.create` call, not global. Example value in the docs is `200000` tokens.
- **Standalone mode**: manual — the developer decides when to call `client.responses.compact(...)`.

There is **no idle-time trigger, no "every N items" trigger, no event-based trigger** documented. The only signal the server uses is the rendered token count.

→ **Implication for Director**: we own the trigger logic in our orchestrator wrapper. Best fit: hybrid — keep a soft `compact_threshold` of ~180k on every `responses.create` as a safety net, *and* fire a manual `responses.compact` after every batch of tool calls that returned >50k tokens of cumulative output (Codex diffs and stack traces can be huge).

---

## 3. What it preserves vs drops

This is the single most important section and the one OpenAI buries. Per the community thread and corroborated by `vb` (OpenAI staff):

> **"All prior user messages are kept verbatim."**
>
> **"Prior assistant messages, tool calls, tool results, and encrypted reasoning are replaced with a single encrypted compaction item."**

So the partition is:

| Item type | Kept verbatim? | Replaced by compaction blob? |
|---|---|---|
| User messages (`role: "user"`) | ✅ Yes | ❌ No |
| System / developer instructions | (implicit — kept; instructions live on the request) | ❌ No |
| Assistant `message` items | ❌ No | ✅ Yes |
| `function_call` items | ❌ No | ✅ Yes |
| `function_call_output` items | ❌ No | ✅ Yes |
| Reasoning items (encrypted) | ❌ No | ✅ Yes |
| Items *after* the compaction item (new turn) | ✅ Yes (kept as-is) | — |

The compaction item itself is described as **"opaque and not intended to be human-interpretable."** It's not a summary you can `console.log` and read. It's a model-internal representation that the next inference pass will decode.

Critically, `vb` flagged a **degenerate case**: *"only certain parts of a conversation can be compacted. If a conversation consists mostly of user messages, those will not be compacted, so the gain is usually close to zero."*

→ **Implication for Director**: For the orchestrator, the conversation is almost entirely *tool calls and assistant reasoning* (Codex dispatch + result, render_canvas + result, update_harness + result). User messages are short and infrequent. So our compaction ratio should be excellent — exactly the opposite of the e-commerce chatbot case where compaction barely helped. **But**: because the orchestrator's *decisions* live in assistant messages and tool calls, those get compacted into an opaque blob. We cannot later ask "what tools did you call 30 minutes ago?" and read the answer — we have to either mirror that data ourselves *outside* the Responses API, or trust the encrypted item.

---

## 4. Configuration knobs

The available knobs are minimal:

| Knob | Where | Values | Effect |
|---|---|---|---|
| `context_management` | `responses.create` body | `[{"type": "compaction", "compact_threshold": <int>}]` | Enables server-side auto-compaction. Array shape suggests more strategies may land later. |
| `compact_threshold` | inside `context_management[i]` | int (tokens) | When rendered context crosses this, compact mid-stream. Example uses `200000`. |
| `store` | `responses.create` / `responses.compact` body | bool | `store=False` makes the flow ZDR-friendly; pairs naturally with stateless input-array chaining. |
| `model` | both endpoints | string | Which model does the compaction. `gpt-5.5`, `gpt-5.3-codex`, `gpt-5.4` confirmed. |
| `previous_response_id` | `responses.create` / `responses.compact` | string | Chain by ID instead of resending the array. Cannot combine with `conversation`. |
| `input` | both endpoints | array of items | The window to compact. |

There is **no documented knob for**:
- Aggressiveness ("compact harder")
- Preservation hints ("never compact items tagged X")
- Per-item retention markers
- Target output token budget
- Soft vs hard threshold

This is a notable absence — Anthropic's equivalent feature exposes `providerOptions.anthropic.contextManagement` with more knobs (per the Vercel AI SDK issue [#12486](https://github.com/vercel/ai/issues/12486)).

→ **Implication for Director**: we cannot say "preserve the Harness items verbatim." We have to engineer preservation by putting the must-keep content into **user messages** (the only category that survives), or by **re-injecting** it on every turn as a system instruction outside the compactable history.

---

## 5. Cost / latency tradeoffs

Compaction itself runs a model pass on the conversation window — so there's a non-trivial token cost (the input tokens of the window being compacted, billed as model input). Amortization:

- **Server-side compaction** "reduces long-tail latency" because future turns operate on a smaller compacted context. Without it, you'd be paying full input-token cost on every turn forever.
- **Standalone** trades one API round-trip for explicit control.
- `gpt-5.5` text input is the relevant rate (vs the orchestrator's normal turn input cost). Per the realtime research doc, audio is far more expensive — but for `gpt-5.5` orchestrator turns we're in text mode, so compaction at ~200k tokens costs roughly one big text-mode inference and replaces ~200k of future repeated input.

Practical math for Director (estimated): if the orchestrator runs for 4 hours at ~25k tokens of new context per 10-minute block, untreated it would hit ~600k by end. Compacting at 180k twice through the session = 2 × 180k of compaction input cost (~$2-4 worth at `gpt-5.5` text input rates) versus tens of dollars of repeated input on every subsequent turn without compaction. Big win.

Community user `_j` raised a fair counter: *"scheduling a compaction run powered by AI doesn't really fit any pattern of 'excellence'."* Translation: you're paying a model to summarize a model. True. But the alternative — manual pruning — drops information without the encrypted-state benefit.

→ **Implication for Director**: budget for ~2-4 compaction passes per active hour. Build a per-session ledger of compaction cost so we can see if it's worth it after the hackathon. Set `store=False` everywhere — we're managing state ourselves anyway and don't need the 30-day server-side persistence.

---

## 6. How it interacts with tool calls

Tool calls (`function_call`) and tool outputs (`function_call_output`) are in the "replaced by compaction blob" bucket. After compaction:

- The exact `arguments` JSON passed to each old tool call: **gone** (encoded in the encrypted blob).
- The `output` returned by each old tool: **gone** (encoded in the encrypted blob).
- The `call_id` linkage: **gone** as a referenceable string.
- The **fact** that those calls happened and what they accomplished: **preserved** (that's the whole point of the encrypted item).

Important nuance: **in-flight** tool calls cannot be compacted away (you have to wait for `function_call_output` to land before its pair can be folded into the blob). The docs don't explicitly say this, but it falls out of the items model — an unmatched `function_call` would leave the conversation in an invalid state.

→ **Implication for Director**: the orchestrator's `dispatch_agent` / `update_harness` / `render_canvas` calls will pile up fast. Most of them are safe to compact *after they complete*. But two patterns break:

1. **Long-running agents**: a Codex job that runs for 10 minutes is an open `function_call` whose `function_call_output` won't arrive until the job finishes. We **cannot compact across an open tool call** for that job — either we artificially close it (return `{status: "started", job_id}`) and reopen with a fresh call later, or we delay compaction until quiescent.
2. **Replaying call_ids in narration**: if the realtime layer (`gpt-realtime-2`) asks the orchestrator "what jobs are running right now?", the orchestrator can't grep through old `call_id`s — they're encrypted. So we mirror the active-job table to a structured side store the orchestrator can query as a tool result.

The standard recommendation, also matching the OpenAI blog post: **return tool results quickly with a `job_id` handle, then send fresh `function_call_output` items when state changes** (matches Director's existing realtime-layer pattern from §3 of the realtime doc).

---

## 7. How it interacts with reasoning models

`gpt-5.5` is a reasoning model. Its reasoning tokens flow through the Responses API as encrypted reasoning items (the same encrypted-reasoning pattern the API has used since the o-series). Per the community thread:

> *"encrypted reasoning [is] replaced with a single encrypted compaction item."*

So reasoning items are **compacted away**, not preserved. The compacted blob is presumably aware of *what the reasoning concluded* (encoded structurally), but the verbose chain of thought is gone after compaction.

This is fine for Director — we don't care about replaying old chains of thought. But it does mean that if the orchestrator made a subtle judgment 20 minutes ago ("I decided not to refactor the auth module because of risk X"), the reasoning that led there is no longer in context. Only the *result* of that reasoning (encoded opaquely in the compaction item, plus whatever assistant messages or tool calls it triggered) survives.

→ **Implication for Director**: when the orchestrator makes a load-bearing judgment that doesn't naturally land as a tool call or a visible assistant message (e.g. "I considered three approaches and picked B because of safety"), we must force it to externalize that decision via a `record_decision` tool call so it's preserved structurally in our side store, even though the API representation will eventually compact away.

---

## 8. Recovery / introspection

The honest answer: **there is no introspection API**. The compaction item is opaque. You cannot:

- Read what was summarized
- Diff "before vs after" compaction
- Ask the model "what did you compact away?"
- Selectively un-compact a region

What you *can* do:

- Keep a parallel transcript log on disk (which Director already does — `~/.director/sessions/<session-id>/`) and grep that for prior content if the model claims to have forgotten something.
- Re-inject summarized prior state as a fresh **user message** (which survives the next compaction round) when you detect the model has lost the thread.
- Use `previous_response_id` chaining to let the server hold the compacted state for you — at the cost of giving up ZDR cleanliness.

→ **Implication for Director**: pair every compaction with a **plaintext side log** maintained by our wrapper. When the orchestrator says "I don't remember discussing X", our wrapper checks the side log; if X is there, we re-inject as a structured `system` instruction or as a synthetic prior user message. This is the safety net for the opaque-blob problem.

---

## 9. Failure modes

From the community threads and what's *not* in the docs:

1. **Compacted state may not persist across calls.** One user reported token usage staying high even after compaction triggered — implying the compaction item wasn't being correctly carried forward in their chain. OpenAI acknowledged documentation gaps. Mitigation: log `len(response.output)` and look for the `type: "compaction"` item explicitly; assert it's present in the next request's `input`.
2. **User-message-heavy conversations get near-zero compaction benefit.** Not Director's profile, but worth flagging if we ever build a chat-style surface.
3. **Opaque blob = silent drift**. If compaction subtly drops or distorts a load-bearing decision, we don't know until the orchestrator acts on outdated context. There's no warning event.
4. **No quality SLA**. OpenAI doesn't promise that compaction preserves any specific fact. It's a best-effort compression.
5. **Server-side compaction fires mid-stream**, which can interleave with tool calls in ways the docs don't fully describe. Standalone is safer for orchestration loops.
6. **`previous_response_id` cannot combine with `conversation`**, which is a constraint when integrating with the Conversations API. Currently underdocumented.

→ **Implication for Director**: treat compaction as **lossy compression of the orchestrator's working memory**. Mirror everything load-bearing externally. Build assertions: after every compaction, the orchestrator should still answer a fixed health-check question ("what's the current task?") correctly — if it doesn't, escalate to a re-injection pass.

---

## 10. Director compaction strategy

Concrete recommendations for the `gpt-5.5` orchestrator.

### 10.1 Trigger policy (hybrid)

- **Safety net**: always pass `context_management=[{"type": "compaction", "compact_threshold": 180000}]` on every `responses.create`. This catches runaway cases.
- **Primary**: call `client.responses.compact(...)` explicitly at quiescent moments:
  - After any batch of tool calls whose cumulative output exceeded 50k tokens (typical: a big Codex diff or a `read_workspace` dump).
  - On user idle ≥ 90 seconds, if context > 80k tokens.
  - Before each Realtime session rotation (every 55 min — see §10.4), as a precondition.
  - Manually via a new `force_compaction` tool exposed to the orchestrator itself ("you should compact now").

### 10.2 Must-preserve content (engineered redundancy)

Because the compaction item is opaque and only user messages survive verbatim, we externalize must-preserve content **as both** a side-store record **and** a re-injected user message on every turn after a compaction event:

| Item | How preserved |
|---|---|
| Active Harness rules | Always re-injected as the leading `system` instruction on every `responses.create`. Source of truth: `~/.director/sessions/<id>/harness.json`. Cost: ~1-3k tokens per turn, cached. |
| Currently-running agent jobs (`job_id`, status, task) | Side store in `harness.json`. Surfaced to orchestrator via a `list_active_jobs` tool result on demand. Also re-injected as a `system` block titled "Active Work" after each compaction. |
| Current task / goal | Stored as a top-of-prompt `system` block: "Current goal: <text>". Updated when orchestrator emits a `set_current_goal` tool call. |
| Last canvas state | Stored in `harness.json`; the orchestrator can `read_canvas_state()` to retrieve. |
| Last 3 user utterances | Naturally preserved verbatim by compaction (user messages are kept). No extra work needed *unless* compaction drops them somehow — in which case the on-disk transcript is our ground truth. |
| Decisions ("we agreed to mock Stripe") | Forced through a `record_decision(text)` tool that appends to a decisions log. Re-injected as a `system` block titled "Active Decisions" after each compaction. |

### 10.3 Safe-to-aggressively-compact content

- Old tool call arguments and results for completed agents (Codex job stdout, large diffs after they've been applied).
- Narration text that was already spoken to the user (the realtime layer already heard it; the user already heard it).
- Intermediate reasoning that didn't change the harness, the goal, or active jobs.
- Old canvas renders the user already responded to.

These naturally fall into the "assistant messages + tool calls + reasoning" bucket that compaction already eats.

### 10.4 Interaction with the 60-min Realtime session rotation

The Realtime session is windowed (60-min cap, ~128k context). The orchestrator (`gpt-5.5`) is the deep memory. Rotation flow:

1. **At T+55min**, the orchestrator runs a manual `responses.compact` to ensure its own state is clean.
2. The orchestrator constructs the **World State Brief** for the new Realtime session by reading from the side store (`harness.json`, decisions log, active jobs) — **not** from its own compacted memory. This is critical: the Brief must be derived from durable structured data, not from the orchestrator's opaque blob.
3. The Brief includes (per `ux-design.md` §2B-1): active agents + statuses, Harness rules verbatim, last canvas state, current goal, last 6 conversation turns verbatim, time elapsed.
4. Brief is injected into the new Realtime session via `conversation.item.create` as a `system` role item before swap.

So the answer to "is the World State Brief derived from gpt-5.5's compacted state?" is **no — it's derived from the side store the orchestrator continuously updates via tool calls.** The orchestrator's compacted memory is the *backup*; the side store is the *source of truth* for cross-session continuity.

### 10.5 Failure handling (the silent-drop guard)

- **Health-check probe after every compaction**: emit a synthetic prompt to the orchestrator: *"In one sentence: what is the current goal, what active jobs are running, and what was the most recent user instruction?"* Compare against the side store. If it disagrees, re-inject the must-preserve content as a fresh `system` block and re-prompt.
- **Decision Ledger**: every `record_decision` call is also persisted to `~/.director/sessions/<id>/decisions.ndjson`. On any user prompt that pattern-matches "earlier you said…" / "remember when…", the orchestrator is required (via system instruction) to invoke `read_decisions(since: <timestamp>)` before answering.
- **Harness immutability via prompt structure**: the Harness lives at the top of `instructions` on every `responses.create` call. Compaction does not touch `instructions`. This is our hardest guarantee.

---

## 11. Open questions (worth a human call)

1. **Is `context_management` actually idempotent across `previous_response_id` chains?** The Feb 2026 community thread suggests compaction items don't always propagate. We should test in our hackathon repo before relying on it.
2. **Can we run `responses.compact` against a window that includes an open (unmatched) `function_call`?** The docs are silent. If it errors, we need to drain in-flight tool calls before compacting — which conflicts with our async Codex dispatch model.
3. **Does the standalone `/responses/compact` endpoint accept `instructions`?** If yes, we can pass the Harness through compaction to ensure it informs the compacted blob. If no, the blob is compressed without that signal.
4. **What's the compaction model fee structure?** Billed as input tokens at `gpt-5.5` text rates, or a separate compaction-tier price? Affects our cost-budget math.
5. **Is there a way to mark items as "must preserve" or "do not compact"?** Anthropic's equivalent has hints; OpenAI's API surface so far doesn't. Worth asking OpenAI staff at the hackathon.
6. **What happens to images in `input` after compaction?** The orchestrator might receive screenshots from the Electron overlay. Are they preserved, dropped, captioned, or replaced?
7. **Does compaction preserve `metadata` on items?** We tag proactive announcements with `metadata.kind`; if metadata survives, we can use it as a forensic trail.
8. **Cross-model compaction sanity**: if we compact with `gpt-5.5` but then inference with `gpt-5.3-codex` for the actual orchestration, does the encrypted item still decode? The blob is presumably model-family-scoped but not strictly model-version-scoped — needs verification.

---

## Sources

- [Compaction guide](https://developers.openai.com/api/docs/guides/compaction.md) — primary
- [/responses/compact API reference](https://developers.openai.com/api/reference/resources/responses/methods/compact)
- [Conversation state guide](https://developers.openai.com/api/docs/guides/conversation-state)
- [Shell + Skills + Compaction blog](https://developers.openai.com/blog/skills-shell-tips)
- [Community thread: compaction with previous_response_id](https://community.openai.com/t/compact-a-response-with-previous-response-id/1372502)
- [Community thread: compaction with Conversations API](https://community.openai.com/t/compact-a-response-with-conversations-api/1378730)
- [Vercel AI SDK feature request #12486](https://github.com/vercel/ai/issues/12486)
