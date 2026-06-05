# Voice + GenUI Spec — source of truth

Status: **LOAD-BEARING / FIXED.** Downstream agents build directly from this. The five
sections below pin decisions that are already made; the job of any implementer is to
realize them precisely, not redesign them. Where this spec and
`docs/research/genui-schema.md` disagree, **this spec wins** (the research doc is the
earlier design sketch; the prop shapes here are the ones the model is instructed to emit
and the components must accept).

Authoritative neighbouring contracts (do not fork — extend append-only per
`docs/contracts.md` §13.1):

- `apps/director/src/shared/realtime.ts` — `RealtimeToolName`, `realtimeToolDefs()`,
  `buildSessionUpdate()`, `DIRECTOR_INSTRUCTIONS`.
- `apps/director/src/shared/ipc.ts` — `IpcChannel`, `DirectorBridge`, all payloads.
- `apps/director/src/shared/canvas-ipc.ts` — `CanvasIpcChannel`, `CanvasRenderPayload`,
  `CanvasUserResponsePayload`.
- `apps/director/src/shared/state.ts` — `Agent`, `AgentStatus`, etc.
- `apps/director/src/renderer/src/state/store.ts` — `commands.*` (never raw `setState`).
- `apps/director/src/renderer/src/canvas/CanvasApp.tsx` — the `component` dispatcher.

Terminology: **Strip renderer** = the always-on overlay window that owns the Realtime
peer (`App.tsx`, `RealtimeClient`). **Canvas window** = the second `BrowserWindow`
(`CanvasApp.tsx`). **Brain** = `main/agent-brain.ts` (`@openai/agents`, gpt-5.5, full
shell). **Planner** = `main/planner.ts` (`consultDirector` → routes to Brain by default).

---

## 1. Async `consult_director` protocol (foreground / background split)

### 1.1 The problem this fixes

`consult_director` today is **synchronous**: `handleConsultDirector`
(`main/tool-router.ts:318`) `await`s `consultDirector(args, …)`, which `await`s
`runAgentBrain(prompt)`. The Brain investigates the real filesystem on gpt-5.5 with
`maxTurns: 40` — routinely 5–30s. The Realtime data channel injects a
`function_call_output` only when that resolves (`client.ts dispatchTool`), so the voice
turn is **blocked** for the whole consult and slow consults can outlast the data channel
(the `tool.result inject dropped … DC closed mid-call` warning in `client.ts:314`). The
voice layer must never block on deep thought.

### 1.2 Fixed shape: fire-and-forget with a ticket + proactive callback

`handleConsultDirector` becomes **async-dispatch**:

1. Validate `args.prompt` (unchanged — empty prompt still returns the `ok:false`
   `missing or empty prompt` error).
2. Mint a `ticketId` (`consult-<Date.now()>-<rand>`).
3. Compute a one-line `restated` string — the human-readable restatement of what the
   user asked, in Director's voice (e.g. user said "should we split the API by
   resource?" → restated `"whether to split the API by resource"`). For v1 the restate is
   `args.prompt` trimmed + collapsed to one line / ≤80 chars; a later pass may have the
   model pass an explicit `restated` arg. **Do not block on producing a fancy restate.**
4. Register the ticket (§1.3).
5. **Kick off `runAgentBrain(args.prompt)` WITHOUT awaiting** (fire-and-forget promise;
   attach `.then`/`.catch` per §1.5). The legacy-planner fallback inside
   `consultDirector` still applies *inside* `runAgentBrain`'s caller — i.e. the async
   worker calls the same `consultDirector(args, stripWindow)` it does today, just not on
   the voice-return path. (Reuse `consultDirector` so the `DIRECTOR_LEGACY_PLANNER`
   fallback + orchestrator.jsonl chaining keep working.)
6. **Return immediately** to the Realtime layer:

```ts
// consult_director tool result (function_call_output payload)
{ status: 'thinking', ticketId: string, restated: string }
```

This is the `output` of `ToolCallResponse { ok: true, callId, output, latencyMs }`. The
model gets it in <50ms.

### 1.3 Ticket registry — `main/consult-tickets.ts` (NEW FILE)

A new module owns the in-flight ticket map (keep it out of `tool-router.ts` so the
router stays a pure dispatcher and the registry is unit-testable headlessly):

```ts
// apps/director/src/main/consult-tickets.ts
export interface ConsultTicket {
  prompt: string;       // the raw prompt sent to the Brain
  restated: string;     // one-line restatement used in attribution
  startedAt: number;    // Date.now() at dispatch
}

const tickets = new Map<string, ConsultTicket>();

export function openTicket(t: ConsultTicket): string;   // returns ticketId
export function getTicket(id: string): ConsultTicket | undefined;
export function closeTicket(id: string): ConsultTicket | undefined; // delete + return
export function _resetTicketsForTests(): void;
```

Lifecycle: `openTicket` on dispatch, `closeTicket` after the proactive announce fires
(success or error). Tickets are ephemeral, in-memory only — no disk, no persistence. A
process restart drops in-flight consults (acceptable — the user re-asks).

Vitest (required): `openTicket` returns a unique id and stores the row; `getTicket`
round-trips; `closeTicket` deletes + returns the row; double-close returns `undefined`.

### 1.4 Completion → proactive injection via the EXISTING announce path

On Brain completion the worker fires a `ToolProactiveAnnounce` — the **same channel** the
hang watchdog already uses (`planner.ts announceAgentHang` → `IpcChannel.ToolProactiveAnnounce`
→ strip window). Payload (`ProactiveAnnouncePayload`, `shared/ipc.ts:283`):

```ts
{
  text: `On ${ticket.restated}: ${summary}`,
  reason: 'agent_done',
  metadata: { kind: 'consult_result', ticketId },
}
```

- `summary` is `AgentBrainResult.summary` (already a tight 1–3 sentence spoken-English
  string per the Brain persona). Do not re-summarize.
- The attribution prefix `"On <restated>: "` is FIXED — it re-anchors the user, who has
  kept talking since the consult started. Example spoken line: *"On whether to split the
  API by resource — yes; split by resource now, it's two files and keeps the route table
  flat."*

### 1.5 Error path

If `runAgentBrain` (and its legacy fallback) reject, fire:

```ts
{
  text: `Couldn't get to the bottom of ${ticket.restated}.`,
  reason: 'agent_done',
  metadata: { kind: 'consult_error', ticketId },
}
```

`reason: 'agent_done'` (not a new enum) so no `ProactiveAnnouncePayload.reason` change is
needed. Always `closeTicket(ticketId)` in a `finally`.

### 1.6 IPC channels

- **Reuse** `IpcChannel.ToolProactiveAnnounce` (`'tool.proactiveAnnounce'`) — already in
  `IpcSendMap`. **No new main→renderer channel for the result.**
- **No new tool-router invoke channel** — `consult_director` still rides `tool.call`.
- **GAP — the renderer consumer does not exist yet.** `ToolProactiveAnnounce` is *emitted*
  by `planner.ts` but **nothing in the preload bridge subscribes to it**, and `App.tsx`
  has no handler. The only proactive-speech path wired today is the `window`
  `director:escalation` CustomEvent from the **sim** (`App.tsx:386`). The async consult
  (and the existing hang watchdog) are dead until this is wired. See §1.7.

### 1.7 Renderer wiring contract (the foreground side)

Two pieces must be added (flagged in WIRING REQUIRED):

1. **Preload bridge** — add to `DirectorBridge` (`shared/ipc.ts`) + `preload/index.ts`:

```ts
// DirectorBridge
proactive: {
  onAnnounce: (cb: (p: ProactiveAnnouncePayload) => void) => () => void;
};
```

Implemented in `preload/index.ts` as an `ipcRenderer.on(IpcChannel.ToolProactiveAnnounce, …)`
subscription (mirror the existing `tool.onResult` shape exactly).

2. **Strip-renderer injector** — an `App.tsx` `useEffect` (or a small
   `useProactiveAnnounce(client)` hook) that subscribes to `bridge.proactive.onAnnounce`
   and injects the text as **unprompted assistant speech**, reusing the proven escalation
   pattern (`App.tsx:407–429`):

```ts
if (client.status !== 'connected' || !client.dcReady) {
  // Optionally reconnect-then-speak; at minimum, log + drop. The consult
  // result is lost if the peer is torn down (idle-teardown). Acceptable v1.
  return;
}
client.send({
  type: 'conversation.item.create',
  item: { type: 'message', role: 'system',
    content: [{ type: 'input_text',
      text: `Say this to the user, verbatim and terse, then stop: "${p.text}"` }] },
});
client.send({ type: 'response.create' });
```

Note the idle-teardown interaction: a consult can outlive the 45s idle peer teardown
(`client.ts idleTeardownMs`). v1 behavior: if the peer is gone when the announce arrives,
log + drop (the user can re-ask). A later pass may reconnect-then-speak.

### 1.8 Persona additions (`DIRECTOR_INSTRUCTIONS`, `shared/realtime.ts`)

Append-only edit to the `# When to consult the planner` and `When you do call
consult_director` blocks. FIXED behaviors:

- On a `status: 'thinking'` result, say **exactly one** short line and **continue the
  conversation** — never wait, never go silent waiting on it. Canonical line:
  **"Digging into that — I'll come back to you."** (Acceptable variants: "On it — I'll
  come back." Keep it to one clause.)
- The deep answer arrives **later** as an unprompted line beginning "On <topic>: …". The
  model does not poll, re-call, or ask "did you get that?".
- **Answer simple / status / acknowledgement turns DIRECTLY — never consult.** Status
  ("what's running?") → answer from state / `list_agents` (§3). Acks ("ok", "got it") →
  one word. Tool-directed ("show the moodboard") → call the tool. Only consult for
  **genuine depth** (architecture, trade-offs, multi-step planning, "how should we…?").
- Delete / supersede the old line *"When the tool returns, NARRATE THE SUMMARY VERBATIM …
  The user is waiting."* — it described the synchronous contract and is now wrong (the
  tool returns `thinking`, not a summary; the user is **not** waiting).

---

## 2. GenUI component prop schemas

All schemas below are **FIXED**. Each new component is a React `.tsx` in
`apps/director/src/renderer/src/canvas/components/` and a `case` in `CanvasApp.tsx`'s
`CanvasBody` switch. Props arrive as `payload.props` (free-form object); cast to the
interface and **render defensively** (tolerate missing fields; never throw — the
`CanvasErrorBoundary` catches throws but a graceful empty state is better).

### 2.0 Selection / response routing (shared by all interactive components)

Interactive components call the `onRespond(value)` prop that `CanvasBody` passes
(`CanvasApp.tsx:115`). That fires `CanvasIpcChannel.UserResponse`
(`canvas.user_response`) → main → relayed to the strip renderer via
`IpcChannel.CanvasUserResponseRelay`. **There is no `canvas_response` Realtime tool** —
"posts canvas_response" in this spec means *fires the `canvas.user_response` IPC with the
value shape below*. The strip-side consumer that turns a relayed response into a Realtime
turn is `ipcSync.ts` (today only the resume picker + onboarding form are routed; a
general router is WIRING REQUIRED). Each value object is wrapped by `CanvasApp`'s
`respond()` into `{ component_id, value, call_id }`.

### 2.1 `options_picker` (interactive)

```ts
interface OptionsPickerProps {
  title?: string;
  question: string;
  options: Array<{ id: string; label: string; detail?: string }>;
  sessionId?: string; // opaque correlation token (e.g. resume picker carries it)
}
```

Render intent: a vertical list of selectable frosted cards — `label` bold, `detail`
muted sub-line. Click (or voice-resolved) selection → call
`onRespond({ option_id: id })`. **Note the value key is `option_id`** (singular) to match
the existing `ipcSync.ts handleResumePickerResponse` reader (`CanvasApp.tsx`→`ipcSync`
already accepts `option_id`/`id`/`concept_id`). Single-select only in v1 (no
`allow_multi`). `sessionId`, when present, must be echoed back so the strip can correlate
(the resume picker depends on this — `buildResumePicker` in `ipcSync.ts:386` already emits
`{ title:'Resume?', question, sessionId, options:[{id,label}] }`, which this schema must
stay compatible with). Lock the list after first selection (mirror `Moodboard`'s
`selectedId` lock).

### 2.2 `html` (display; sandboxed)

```ts
interface HtmlProps {
  title?: string;
  html: string; // model-authored HTML
}
```

Render intent: render the `html` string in a **sandboxed `<iframe srcDoc={html}>`**.
FIXED security rule: the iframe `sandbox` attribute must **omit `allow-scripts`** by
default — model-authored HTML does **not** execute JavaScript. (The research doc's
`allow-scripts` + postMessage bridge is explicitly deferred; v1 is inert HTML/CSS only.)
Set `sandbox="allow-same-origin"` off too where possible; the safest stance is
`sandbox=""` (fully sandboxed, no scripts, no same-origin) which still renders markup +
inline styles. Display-only — no `onRespond`. Optional `title` renders as the card
header. Do **not** inject the string via `dangerouslySetInnerHTML` into the canvas DOM —
it must be iframe-isolated.

### 2.3 `code_preview` (display, read-only v1)

```ts
interface CodePreviewProps {
  title?: string;
  path?: string;     // file path, shown in the header if present
  language?: string; // hint for the highlighter; default plaintext
  code: string;
}
```

Render intent: monospaced, syntax-highlighted, read-only code block on a near-black
panel; header shows `path` (preferred) or `title`; line-number gutter. **No actions / no
diff in v1** (the research doc's `actions` + `diff_against` are deferred — the
fan-in approval flow in `codex-pool.ts` renders this card display-only today). Pick a
light highlighter (e.g. `highlight.js` or `prismjs`) or ship a no-highlight `<pre><code>`
fallback if adding a dep is undesirable — either is acceptable; correctness > color.
Display-only — no `onRespond`.

### 2.4 `diagram` (display)

```ts
interface DiagramProps {
  title?: string;
  kind: 'mermaid' | 'dot';
  source: string;
}
```

Render intent: render `source` as a diagram. `kind: 'mermaid'` → mermaid.js;
`kind: 'dot'` → Graphviz (e.g. `@viz-js/viz` / `d3-graphviz`). Dark frosted background.
On render failure, fall back to a `<pre>` of the raw `source` (never throw). Display-only
— no `onRespond`. (This supersedes the research doc's `{ mermaid: string }` field name:
the FIXED field is `source` + a `kind` discriminator.)

### 2.5 `agent_pod` (display; live Hive in the Canvas)

```ts
interface AgentPodProps {
  agents: Array<{
    id: string;
    name: string;
    role: string;        // 'Frontend' | 'Backend' | 'Data' | 'Design' | string
    accentColor: string; // '#RRGGBB'
    status: 'spawning' | 'working' | 'blocked' | 'thinking' | 'done' | 'error' | 'killed';
    currentTask: string | null;
    recentFiles: string[];
    trail?: string[];    // optional task micro-text history (taskTrail)
  }>;
}
```

Render intent: the live Hive promoted into the Canvas — a vertical column of agent
nodes, each a status disc (color by `status`, accent ring by `accentColor`) + name +
`currentTask` micro-text + a `recentFiles` breadcrumb (mono, cap 3). This is the
Canvas-sized sibling of `HiveStrip`/`AgentRow` — **reuse `AgentRow`'s presentation**
(`renderer/src/components/AgentRow.tsx`) rather than re-deriving the row layout; the
`agent` field shapes line up 1:1 with `shared/state.ts` `Agent` (so a store `Agent[]`
can be passed straight through — see §3.2). Display-only — no `onRespond`. Status→fill
map matches `AgentRow.STATUS_FILL`.

### 2.6 De-demo fix for `artifact_preview` (render ONLY props)

`ArtifactPreview.tsx` currently hardcodes `MOCK_MIXTAPE` (Tokyo-neon synthwave roster)
and **merges it under any provided props** (`{ ...MOCK_MIXTAPE, ...providedMixtape }`,
lines 34–68), so a caller who omits a field silently gets demo data. It also points an
`<iframe>` at `http://localhost:3001` whenever a `vibe` is provided. FIXED fix:

- **Delete `MOCK_MIXTAPE`** and the spread-merge. Render strictly from props.
- Align to the generic artifact shape (supersedes the Mixtape-specific shape):

```ts
interface ArtifactPreviewProps {
  title?: string;
  kind?: 'iframe' | 'image' | 'html';
  src?: string;            // url / data-url for iframe|image
  html?: string;           // when kind === 'html' (sandboxed, no scripts — see §2.2)
  notes?: string;
  actions?: Array<'ship' | 'iterate' | 'discard'>;
  onAction?: (a: 'ship' | 'iterate' | 'discard') => void;
}
```

- Empty/missing `src`+`html` → a calm empty state ("Nothing to preview yet"), **not**
  demo tracks. Keep the flip-card chrome only if a structured artifact is passed; default
  is a plain framed preview.
- Remove the `localhost:3001` default. An iframe renders only when `kind==='iframe'` and
  `src` is a real URL.
- `actions` defaults to `['ship','iterate','discard']` only when interactive; selection →
  `onAction(action)` → `onRespond({ action })` (unchanged routing).
- The Mixtape demo content moves behind the explicit demo trigger (§4) — `ChatSurface`
  and the `index.ts` dev hotkey pass the full props object, so they keep working without
  any in-component fallback.

### 2.7 Enum sync

`render_canvas` `component` enum (`realtimeToolDefs()`, `shared/realtime.ts:99–117`)
already lists `options_picker`, `code_preview`, `diagram`, `html`, `agent_pod` (plus
`moodboard`, `form`, `artifact_preview`, and the degradation cards). **No enum change
needed** — the names are already declared; only the `CanvasApp` cases + components are
missing. (`shared/state.ts CanvasComponentName` and `canvas-ipc.ts CanvasKnownComponent`
are looser/legacy unions — widen them to include the five names if you touch them, but
they are not the gate; `CanvasApp` falls through to `UnknownComponent` for anything not
in its switch, which is the real surface.)

---

## 3. Agent-visibility contract

### 3.1 `list_agents` — synchronous Realtime tool (NEW)

A foreground tool so the model answers "what's running?" instantly from state, **without
consulting**. Add to `RealtimeToolName` + `realtimeToolDefs()` (append-only) +
`DIRECTOR_INSTRUCTIONS` tool list + the `ToolName` union in `shared/ipc.ts` + the
`tool-router.ts` switch.

Tool def:

```ts
{
  type: 'function',
  name: 'list_agents', // RealtimeToolName.ListAgents = 'list_agents'
  description:
    "List the sub-agents currently running and what each is doing. Use to answer 'what's happening?' / 'what's running?' / status questions — never consult the planner for this.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },
}
```

Handler (`handleListAgents` in `tool-router.ts`) return shape:

```ts
{ agents: Array<{ name: string; role: string; status: string; currentTask: string | null }> }
```

**Data-source problem + decision.** The canonical agent state lives in the **renderer
Zustand store** (`store.agents`), which the main process does **not** mirror. The router
is main-side. Two FIXED options — implement **(a)**:

- **(a) Main-side side-store mirror (CHOSEN).** The router already mutates an agent
  snapshot into the side-store on dispatch (`queueAgentWrite` in `tool-router.ts:247`,
  and `writeMeta`/agent JSON via `side-store.ts`). `handleListAgents` reads the side-store
  world view (`readWorldState()` in `side-store.ts`, already used by `planner.ts` —
  exposes `activeAgents`) and maps it to the return shape. This keeps the handler
  synchronous-ish (a fast disk read) and main-local. The kill/extend + dispatch handlers
  already write enough agent state for this to be populated.
- (b) Renderer round-trip (rejected for v1): main asks the strip window for a store
  snapshot over IPC. More moving parts, adds latency to a "snappy status" tool.

Until real dispatch is on (§3.3) the side-store is populated by `dispatch_agent_mock` +
the kill/extend handlers, so `list_agents` reflects the mock/sim agents — which is the
correct demo behavior.

### 3.2 How `agent_pod` gets live data

`agent_pod` is **display-only and re-render-on-tick**, driven from the **renderer store**
(it lives in the Canvas, but the strip renderer owns the store + the canvas relay). Flow:

1. A store selector produces `Agent[]` — reuse `useAgentsOrderedForHive()`
   (`state/selectors.ts:65`), whose output already matches the `agents[]` field of
   `AgentPodProps` 1:1 (id, name, role, accentColor, status, currentTask, recentFiles,
   `taskTrail`→`trail`).
2. To **open** the pod in the Canvas window, the strip renderer relays a `canvas.render`
   via `window.director.canvas.render({ component: 'agent_pod', props: { agents }, … })`
   (same relay the resume picker uses, `ipcSync.ts:462`).
3. To keep it **live**, re-relay `agent_pod` whenever the agents slice changes. The
   subscription seam is `ipcSync.ts` (it already `useStore.subscribe`s for the snapshot
   push, `initSnapshotPush`). Add a sibling subscriber: when the Canvas currently shows
   `agent_pod` and `store.agents`/`agentOrder` changed, re-relay the fresh `agents` props
   (debounce ~120ms). Codex events already flow `codex.event → ipcSync handleCodexEvent →
   commands.updateAgent`, so this subscription captures real agent progress for free.

(The model may also `render_canvas('agent_pod', { agents:[…] })` with an explicit list,
but the live path above is the primary one and is what "what's happening, show me"
triggers.)

### 3.3 Real dispatch — drive the real codex-pool, not the sim mock

Today `dispatch_agent_mock` (`handleDispatchAgentMock`, `tool-router.ts:216`) records a
fake agent in the store and, on first call, kicks the **Mixtape sim** (`startSim` patch).
The real pool (`main/codex-pool.ts dispatchAgent` → `codex-pool-core dispatchAgentCore`,
spawning real Codex subprocesses, emitting `codex.event`) exists and is wired for IPC
(`registerCodexPoolIpc` in `index.ts:678`) but **is not reachable from the Realtime tool
surface** — only `dispatch_agent_mock` is.

FIXED contract:

- **Flag:** `DIRECTOR_REAL_AGENTS`. **Default OFF** (mock/sim) for the hackathon demo;
  `DIRECTOR_REAL_AGENTS=1` switches `dispatch_agent_mock`'s handler to drive the real
  pool. (Mirror the `DIRECTOR_LEGACY_PLANNER` env-flag style already used in
  `planner.ts:451`.) Keep the **same tool name** `dispatch_agent_mock` on the Realtime
  surface so the persona + enum are unchanged — the flag only swaps the *handler body*.
  (Optionally also register a real `dispatch_agent` tool later; not required for v1.)
- **When ON,** `handleDispatchAgentMock`:
  1. Resolves identity (`resolveIdentity`, unchanged) → `{ id, name, role, accentColor }`.
  2. Calls `dispatchAgent({ agentId, name, role, task, targetRepo, baseBranch?, batchId? })`
     (`DispatchAgentRequest`, `codex-pool-core.ts:37`). `targetRepo` = the Brain's roaming
     cwd / `DIRECTOR_PROJECT_ROOT` / `$HOME` (see §5 — agents work where the user is
     working; do **not** invent a project picker). Returns `{ ok, agentId, worktree,
     branch }` immediately.
  3. Does **NOT** push the synthetic `addAgent` patch or `startSim` — the real pool emits
     `codex.event { type:'agent_started', … }` which `ipcSync.handleCodexEvent` maps to
     `commands.addAgent`. (Avoid double-adding: when the flag is on, skip the manual
     `sendStripPatch('agents', { action:'addAgent' })`.)
  4. Returns `{ agent_id, worktree, branch }` to the model.
- **Event flow (already built — do not rebuild):** `codex-pool-core` emits → `codex-pool.emit`
  → strip window `IpcChannel.CodexEvent` → preload `bridge.codex.onEvent` → `ipcSync.handleCodexEvent`
  → `commands.*`. The Hive (`HiveStrip`/`AgentRow`) and `agent_pod` (§3.2) both read the
  store, so they light up with real progress automatically. Hang watchdog + fan-in merge
  are likewise already wired off `codex.event`.
- **When OFF,** behavior is exactly today's: mock agent + sim kick. The demo path is
  unchanged.

---

## 4. De-demo map

Every place Mixtape / Tokyo-neon / sim demo data is hardcoded or can leak into a
non-demo path. Fix = **gate behind an explicit demo trigger**, **render from props
only**, or **genericize copy**. The demo must still work when explicitly invoked (dev
keys, the `ChatSurface` "Start Mixtape Demo" button) — we are removing *implicit* leaks,
not the demo.

| # | Location | Leak | Fix |
|---|----------|------|-----|
| 1 | `renderer/src/canvas/components/ArtifactPreview.tsx:33–68` | `MOCK_MIXTAPE` const + spread-merge under provided props; omitted fields silently render Tokyo-neon tracks | Delete `MOCK_MIXTAPE`; render strictly from props per §2.6; empty state when no `src`/`html`. |
| 2 | `renderer/src/canvas/components/ArtifactPreview.tsx:69–72,149–171` | Hardcoded `http://localhost:3001/?vibe=…` iframe whenever a `vibe` is provided | Remove the localhost default; iframe only when `kind==='iframe'` + real `src` (§2.6). |
| 3 | `main/tool-router.ts:254–263` | `handleDispatchAgentMock` auto-kicks the Mixtape sim (`startSim` patch) on first dispatch — fires in **any** session, not just the demo | Gate behind `DIRECTOR_REAL_AGENTS` off **and** an explicit demo flag; when real agents are on, never start the sim. Default demo behavior preserved only under the demo trigger (dev key / ChatSurface button), not on every first dispatch. |
| 4 | `renderer/src/state/ipcSync.ts:88–93` | `startSim` patch action calls `startMixtapeDemo` from a main-driven patch | Keep the patch handler, but it must only be emitted by the demo trigger (see #3), never by a production dispatch. |
| 5 | `renderer/src/state/ipcSync.ts:340–362,630–634` | `handleAsk` + `answerAsk` hardwire every `ask_user` to the sim's Jin/Stripe `resolveJinBlocker` | Make the sim resolution conditional on the sim being active (`isDemoRunning()` from `sim.ts:417`); in production, `ask_user` answers route only to the pending-ask resolver, not the sim. |
| 6 | `renderer/src/components/ChatSurface.tsx:24,79–82,100–110,278–281` | Hardcoded cassette moodboard + Tokyo-neon artifact + "Start Mixtape Demo" button | This is an explicit **debug surface** — acceptable as the demo trigger. Keep, but ensure ChatSurface is dev/debug-only (it is the chat-debug window) and never the production strip. No change required beyond confirming it's gated to the debug window. |
| 7 | `main/index.ts:240–310` | Dev Canvas hotkeys (`⌃⌥⌘M/A`) render hardcoded Mixtape moodboard + Tokyo-neon artifact | Already `if (is.dev)` gated (`index.ts:244`). Acceptable as a demo/QA trigger; no change. (These now pass full props, so they exercise the de-demo'd `ArtifactPreview` correctly.) |
| 8 | `renderer/src/state/sim.ts` (whole module) | The Mixtape timeline, PLAN roster, Jin/Stripe blocker, cassette harness seed | Keep as-is — it **is** the demo, invoked only via the explicit triggers (#3/#4/#6/#7). No auto-start exists at import time (verified: `startMixtapeDemo` is only called from dev keys, the ChatSurface button, and the gated `startSim` patch). Do not import it on any production code path. |
| 9 | `main/codex-pool-core.ts:42,82,87` | Agent persona `tone` examples reference "Mixtape schema", "cassette palette" | Genericize the example phrasings (e.g. "schema written", "tokens locked") so a real non-Mixtape project doesn't get Mixtape-flavored narration. Low priority (examples only), but genericize. |
| 10 | `main/codex-pool-core.ts:42`, `main/codex-worktree.ts:25`, `main/side-store.ts:597` | Comments say target repo "typically examples/mixtape" / project root "~/code/mixtape" | Comment-only; genericize to "the user's target repo / cwd" to reflect the roaming-cwd model (§5). No behavioral change. |
| 11 | `shared/realtime.ts` `DIRECTOR_INSTRUCTIONS` | Persona is already generic (no Mixtape refs) ✓ | No demo leak. (Listed to confirm: the persona must stay project-agnostic — do not add Mixtape examples.) |

There is **no sim auto-start** and **no seeded agents** on a cold production boot — the
roster is only seeded into `harness.json` as a *text rule* at onboarding
(`tool-router.ts:559 AGENT_IDENTITY_ROSTER`), which is generic identity metadata, not demo
data. Leave it.

---

## 5. Directable working directory (ALREADY IMPLEMENTED — spec, do not redesign)

The Brain (`main/agent-brain.ts`) runs a **persistent, roaming shell cwd**, exactly like a
real terminal session. This is done; do **not** propose changes to `agent-brain.ts`'s cwd
handling.

Facts (for downstream context, verified in `agent-brain.ts`):

- `startDir()` (`:49`) returns `resolve(DIRECTOR_PROJECT_ROOT || homedir())` — the
  **starting hint only**, defaulting to `$HOME`. Not a jail.
- `makeLocalShell` (`:151`) holds one `currentCwd` that **persists across commands AND
  across consults** — every command runs `cd '<cwd>'; <command>` and recovers `$PWD` via
  the `__DIRCWD__:` sentinel (`:99–148`), so any `cd`/`mkdir -p new && cd new` the agent
  issues **sticks**.
- The agent persona (`BRAIN_INSTRUCTIONS`, `:172`) already tells it: roam where directed,
  `cd` and stay, "the working location is a conversation, not a config."

What this spec pins (the parts that touch the Realtime persona + onboarding copy):

- **Realtime persona (`DIRECTOR_INSTRUCTIONS`):** add one line establishing that Director
  works **wherever it's told** — e.g. *"You work wherever the user points you: 'work in
  ~/dev/foo', 'make a new folder and build there'. You are not pinned to one project; the
  working directory roams with the conversation."* This keeps the voice layer's framing
  consistent with the Brain. Append-only.
- **Onboarding:** **do NOT add a "pick your project root" step or a project-root jail.**
  The onboarding form (`useOnboarding.ts`) currently collects only `{ title, submitLabel }`
  visibly and persists `{ projectPath?, voice, apiKey }` — `projectPath` is **optional**
  and is at most the *starting hint* (it flows to `meta.json` via `handleOnboardingComplete`,
  `tool-router.ts:564`, and to `DIRECTOR_PROJECT_ROOT`-equivalent state). Keep it optional.
  Any onboarding copy must frame location as "where do you want to start? (you can move me
  anytime by voice)" — never a mandatory gate.
- `DIRECTOR_PROJECT_ROOT` is the optional starting hint, default `$HOME`. The real-dispatch
  `targetRepo` (§3.3) derives from the same roaming cwd / hint — agents are dispatched
  into wherever the user is currently working.

No code changes to `agent-brain.ts`. The only edits this section implies are the one
persona line in `shared/realtime.ts` and ensuring onboarding copy stays non-jail.

---

## Appendix: WIRING REQUIRED (for the Integrate wave)

This spec only authors the doc. The build/integration waves must connect:

1. **Async consult** — `main/tool-router.ts handleConsultDirector` (line ~318): stop
   awaiting; mint ticket via new `main/consult-tickets.ts`; fire `runAgentBrain`/
   `consultDirector` unawaited; return `{ status:'thinking', ticketId, restated }`; on
   settle, send `IpcChannel.ToolProactiveAnnounce` with the `On <restated>: <summary>` /
   `Couldn't get to the bottom of <restated>.` payloads; `closeTicket` in `finally`.
2. **Proactive announce consumer** — `shared/ipc.ts DirectorBridge` + `preload/index.ts`:
   add `proactive.onAnnounce` (subscribe `IpcChannel.ToolProactiveAnnounce`). `App.tsx`:
   add the injector `useEffect`/hook (reuse escalation pattern at `App.tsx:407`). This
   also lights up the **existing** hang-watchdog announce, which is currently dead.
3. **`list_agents` tool** — `shared/realtime.ts` (`RealtimeToolName.ListAgents`,
   `realtimeToolDefs()`, persona tool list), `shared/ipc.ts ToolName` union,
   `main/tool-router.ts` switch + `handleListAgents` reading `side-store.readWorldState()`.
4. **`agent_pod` live data** — `renderer/src/state/ipcSync.ts`: add a `useStore.subscribe`
   sibling to `initSnapshotPush` that re-relays `canvas.render('agent_pod', { agents })`
   (from `useAgentsOrderedForHive`-equivalent selector) when the agents slice changes and
   the Canvas currently shows `agent_pod`.
5. **Real dispatch flag** — `main/tool-router.ts handleDispatchAgentMock`: branch on
   `DIRECTOR_REAL_AGENTS`; when on, call `codex-pool.dispatchAgent(...)` with
   `targetRepo` = roaming cwd, skip manual `addAgent`/`startSim`.
6. **New canvas components + `CanvasApp` cases** — `OptionsPicker`, `Html`, `CodePreview`,
   `Diagram`, `AgentPod` `.tsx` files + `CanvasBody` switch arms (`CanvasApp.tsx:192`);
   de-demo `ArtifactPreview.tsx`.
7. **Persona edits** — `shared/realtime.ts DIRECTOR_INSTRUCTIONS`: async-consult lines
   (§1.8) + roaming-cwd line (§5), append-only.
8. **De-demo edits** — per the table in §4 (items 1–5, 9–10 are behavioral; 6–8, 11 are
   confirm-only / comment-only).
