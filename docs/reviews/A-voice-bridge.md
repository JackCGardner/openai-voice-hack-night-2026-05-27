# Review A — Voice + Realtime + Bridge

> Reviewer: independent sonnet agent. Date: 2026-05-27.

## Summary

The WebRTC plumbing, SDP exchange, and token mint are solid — the critical `window.director bridge missing` bug is properly fixed with `sandbox: false` on both windows and `contextBridge.exposeInMainWorld` running unconditionally. Two blockers remain: the `dispatch_agent_mock` tool schema has drifted significantly from `contracts.md § 4.2` (different required fields, different parameter names), and the `update_harness` schema is missing the required `why` field. There are additional CSP gaps and session-config drift worth resolving before the demo.

---

## Findings

### BLOCKERS

#### BLOCKER-1: `dispatch_agent_mock` schema conflicts with contracts.md § 4.2

- **What**: `shared/realtime.ts` defines `dispatch_agent_mock` with parameters `agent` (string enum: maya/jin/cleo/wren) and `task`. Contracts.md § 4.2 specifies parameters `name` (string), `role` (enum: frontend/backend/data/design), and `task` — and both `name` and `role` are required. The two schemas are incompatible: the contract uses role-based dispatch (matching the agent store's `AgentRole` type), but the implementation uses agent-name-based dispatch.
- **Where**: `apps/director/src/shared/realtime.ts:116-135` vs `docs/contracts.md:269-282`
- **Why it matters**: The tool-router in `main/tool-router.ts` dispatches based on the arguments the model sends. If the model is given the implementation schema (name enum) but the router expects the contract schema (role + name fields), agent dispatch will fail silently or produce wrong behavior. This is a hard split.
- **Suggested fix**: Decide which shape is canonical and update the other. If the name-enum approach wins, update `contracts.md § 4.2` with a doc commit first. If the role-approach wins, change `realtimeToolDefs()` to match. Either way, the mint config and session.update must be in sync.

#### BLOCKER-2: `update_harness` missing required `why` field

- **What**: Contracts.md § 4.4 declares `update_harness` as requiring both `rule` and `why` fields. The implementation in `shared/realtime.ts:153-172` only declares `rule` as required and does not define a `why` parameter at all.
- **Where**: `apps/director/src/shared/realtime.ts:153-172` vs `docs/contracts.md:306-316`
- **Why it matters**: The tool-router's `handleUpdateHarness` handler almost certainly expects a `why` argument to write to `harness.json` (per contracts.md § 4.4 behavior: "appends to harness.json"). The model will never produce a `why` field if it's not in the schema, so all harness saves will be incomplete. Downstream: `HarnessRule` type requires `why: string` (contracts.md § 2.4).
- **Suggested fix**: Add `why: { type: 'string', description: 'Why this rule matters — one sentence.' }` to the `update_harness` parameters, and add `'why'` to the required array.

---

### MAJOR

#### MAJOR-1: CSP does not cover `https://*.openai.com` for SDP exchange

- **What**: The CSP in `index.html` allows `https://api.openai.com` and `wss://api.openai.com` explicitly, but not the wildcard `https://*.openai.com`. The SDP POST goes to `https://api.openai.com/v1/realtime/calls`, which is covered. However, if OpenAI ever redirects the SDP exchange through a CDN subdomain or regional endpoint (e.g. `https://realtime.openai.com`), the CSP will block it silently with no user-visible error, only a devtools CSP violation.
- **Where**: `apps/director/src/renderer/index.html:7`
- **Why it matters**: CSP violations in Electron's renderer are hard to debug — the connection just fails with a network error and no clear cause. Given that the SDP URL is the single most fragile network call in the whole session flow, this is worth hardening now.
- **Suggested fix**: Extend `connect-src` to `https://*.openai.com wss://*.openai.com` or at minimum document clearly why only `api.openai.com` is needed.

#### MAJOR-2: `buildSessionUpdate` in renderer omits `audio.output.format.rate` — will cause HTTP 400 if the server ever processes a cold session.update

- **What**: The mint config in `main/realtime.ts` correctly sends `audio.output.format: { type: 'audio/pcm', rate: 24000 }` (per the inline comment noting omission returns HTTP 400). However, `buildSessionUpdate()` in `shared/realtime.ts:205-227` sends only `audio.input` in the session object — no `audio.output` at all. The renderer sends this update right after `dc.onopen`.
- **Where**: `apps/director/src/shared/realtime.ts:205-227`, `apps/director/src/renderer/src/realtime/client.ts:288-294`
- **Why it matters**: If this `session.update` is processed server-side before the minted config takes effect (e.g., on a connection where the token pre-binds a partial config), the missing `audio.output.format.rate` could cause a 400. More likely the server ignores missing fields on `session.update` (it only returns what changed), but the implementation comment in `main/realtime.ts:44-46` explicitly warns this field is required — consistency matters.
- **Suggested fix**: Either add `audio.output.format: { type: 'audio/pcm', rate: 24000 }` to `buildSessionUpdate`, or add a comment explaining why the renderer update intentionally omits output config (because the mint already set it immutably).

#### MAJOR-3: `contextBridge` exposeInMainWorld is conditional — the else-branch writes to `window` directly, which does not work with `contextIsolation: true`

- **What**: The preload's else-branch (`preload/index.ts:99-102`) sets `window.director` directly on the non-isolated window. The BrowserWindow is configured with `contextIsolation: true`. If `process.contextIsolated` ever returns false despite that flag (or in a dev edge case), the assignment to `window` in the isolated world won't propagate to the renderer world. More importantly, the `else` path exists for `contextIsolation: false` — but the webPreferences always set `contextIsolation: true`, making the else-branch dead code that creates confusion.
- **Where**: `apps/director/src/preload/index.ts:93-102`
- **Why it matters**: If a future worker sees `contextIsolation: false` mentioned anywhere (or sets it "temporarily for debugging"), the bridge will silently go missing again — the original symptom.
- **Suggested fix**: Remove the else-branch entirely, or replace it with `console.error('[preload] contextIsolation is false — bridge will not work; check webPreferences')` and a hard throw. Document that `contextIsolation: true` is non-negotiable.

#### MAJOR-4: Escalation injection guards `status === 'connected'` but not `dc.readyState === 'open'`

- **What**: The escalation handler in `App.tsx:231-251` checks `client.status !== 'connected'` before injecting, which is correct. However, `client.send()` internally checks `dc.readyState === 'open'` and returns `false` silently if the channel is not open (client.ts:383-386). The escalation handler then checks `!okItem || !okResp` and logs a warning but does not retry. In the window between `status` reaching `connected` and the data channel fully opening, injections are silently dropped.
- **Where**: `apps/director/src/renderer/src/App.tsx:231-251`
- **Why it matters**: The escalation flow is specifically called out in the review spec as needing both guards. The missing explicit DC check means proactive agent-completion announcements (the "load-bearing finding" per gpt-realtime-2.md § 8) can drop silently right after connection.
- **Suggested fix**: In `RealtimeClient`, expose a `dcReady` getter (`this.dc?.readyState === 'open'`), and add `!client.dcReady` to the escalation guard alongside the status check.

---

### MINOR

#### MINOR-1: `render_canvas` `component` parameter uses open string, not enum

- **What**: Contracts.md § 4.1 defines `component` as an enum: `["moodboard", "options_picker", "code_preview", "form", "artifact_preview", "harness_rule_save", "agent_pod"]`. The implementation in `shared/realtime.ts:95-99` uses a free-form string with only a description listing the options. The model will not be constrained to valid component kinds.
- **Where**: `apps/director/src/shared/realtime.ts:95-99`
- **Why it matters**: The model may hallucinate component kind names ("modal", "picker", etc.), which the canvas renderer will not recognize, causing a silent no-op render. The canvas window presumably validates by component kind — an unknown kind will just not render.
- **Suggested fix**: Add `enum: ['moodboard', 'options_picker', 'code_preview', 'form', 'artifact_preview', 'harness_rule_save', 'agent_pod']` to the `component` property schema.

#### MINOR-2: `contracts.md § 2.7` `RealtimeEphemeralToken` shape is missing `model` field

- **What**: The actual `RealtimeEphemeralToken` interface in `shared/realtime.ts:33-40` includes a `model: string` field. The canonical contract definition in `contracts.md § 2.7` does not. This is a doc drift, not a code bug.
- **Where**: `docs/contracts.md:157-162` vs `apps/director/src/shared/realtime.ts:33-40`
- **Why it matters**: Workers reading the contract will not know `model` is available on the token. Low risk but worth a doc-commit fix.
- **Suggested fix**: Add `model: string;  // model id echoed back` to § 2.7 in a `docs(contracts): clarify RealtimeEphemeralToken` commit.

#### MINOR-3: `canvas.ts` preload `removeListener` removes ALL listeners, not the specific one

- **What**: `canvas.ts:29-32` calls `ipcRenderer.removeAllListeners(channel)` regardless of which listener is passed. If a second subscriber registers on the same channel, both are dropped on the first unsubscribe.
- **Where**: `apps/director/src/preload/canvas.ts:29-32`
- **Why it matters**: Currently the canvas window likely has only one subscriber per channel (single React tree), but this is a fragile assumption. Any future second subscriber on a canvas channel will be silently deregistered.
- **Suggested fix**: Cache a `Map<channel, Set<wrapped-listener>>` in the preload and use `ipcRenderer.removeListener(channel, wrappedListener)` for precise cleanup.

#### MINOR-4: `session.update` `buildSessionUpdate` omits `audio.input.format` block

- **What**: The mint config sends `audio.input.format: { type: 'audio/pcm', rate: 24000 }` (client.ts session config). The `buildSessionUpdate` renderer-side update sends `audio.input` with only `turn_detection` and `transcription` — no `format`. Minor because the mint has already set this immutably for the session, but creates confusion for future maintainers reading the update payload.
- **Where**: `apps/director/src/shared/realtime.ts:213-226`
- **Why it matters**: Polish / maintainability. Not a runtime bug given mint pre-configures the session.
- **Suggested fix**: Add a comment: `// audio.input.format omitted — immutably set at mint time` to make the omission intentional.

---

## Architectural concerns

**Schema drift between mint config and `session.update`** is the most fragile pattern in this layer. The mint (main process) and the `buildSessionUpdate` (renderer) are supposed to be in sync, but they already differ on `audio.output`, `reasoning`, `speed`, and `audio.input.format`. There is no test or assertion that validates they match. As the tool list evolves, this will become a maintenance problem. The comment "belt-and-braces" in `client.ts:287` correctly acknowledges this, but the actual divergence between the two payloads is already non-trivial. Consider a single `sessionConfigShape()` function that both the mint wrapper and `buildSessionUpdate` call, so drift is structurally impossible.

**Tool schema is the single source of truth claim is not fully true.** `realtimeToolDefs()` is called both from the mint and from `buildSessionUpdate`, which is correct — one source. But `contracts.md § 4` contains a separate authoritative schema definition that has already drifted from the code (see BLOCKER-1 and BLOCKER-2). The doc is supposed to be "source of truth" per § 0, but the code is already ahead/diverged. This creates reviewer confusion and will cause future integration bugs when a worker trusts the doc over the code.

---

## What's working well

- **Bridge resolution is correct**: `sandbox: false` is set on the Strip window (confirmed at `index.ts:95`) and `contextIsolation: true` is preserved alongside it, exactly matching § 9.2. The diagnostic `console.log('[preload] script loaded', ...)` at `preload/index.ts:1-4` is present and emits both `contextIsolated` and `sandboxed` flags — excellent.
- **SDP URL is correct**: `https://api.openai.com/v1/realtime/calls` at `client.ts:22` matches gpt-realtime-2.md § 6 exactly. No legacy `?model=` query string.
- **Token mint payload is complete**: All required fields per § 6 are present — `model`, `voice`, `turn_detection.type: 'semantic_vad'`, `audio.input.transcription.model: 'gpt-4o-mini-transcribe'`, `audio.output.format.rate: 24000`. The defensive dual-shape response parsing (top-level `value` vs nested `client_secret.value`) is thoughtful.
- **Tool dispatch round-trip**: The `pendingCalls` map pattern for resolving function names across events, feeding `function_call_output` back, and then `response.create` is correctly implemented and matches the § 3 flow exactly.
- **`usePlannerNarration` stub**: Correctly no-ops when `bridge.planner.onReasoningDelta` is absent, with a clear comment explaining it lights up when Worker 1 adds the namespace. Will not break App.tsx imports.
- **Escalation injection spec compliance**: The `conversation.item.create` with `role: 'system'`, `content: [{type: 'input_text', text}]` followed by `response.create` matches gpt-realtime-2.md § 8 exactly.
- **DIRECTOR_INSTRUCTIONS persona**: Terse, bans filler phrases, names agents not "I", brief apology policy, silence-as-feature explicit. `consult_director` usage rules (when to call, when not, narrate verbatim) are all present.
