# Voice + GenUI Spec — source of truth

Status: **LOAD-BEARING / FIXED.** Downstream agents build directly from this. The sections
below pin decisions that are already made; the job of any implementer is to realize them
precisely, not redesign them. Where this spec and `docs/research/genui-schema.md` disagree,
**this spec wins** (the research doc is the earlier design sketch; the prop shapes here are
the ones the model is instructed to emit and the components must accept).

This doc is in **two parts**. **Part I (§1–§5)** pins the async-`consult_director` protocol,
the original component prop schemas, the agent-visibility contract, the de-demo map, and the
roaming working directory. **Part II (§6–§10)** is the **complete GenUI + usage contract**:
the full component roster with exact TypeScript prop interfaces (the authoritative shapes —
they match the live components), two NEW components (`gantt`, image-gen `moodboard`), the
per-component agent-usage rules that become persona text, and the
think-vs-Codex-vs-foreground tool-selection logic for both personas. Read Part II for "what
can I render and when do I render it"; read Part I for "how does the plumbing behave".

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

---

# Part II — Complete GenUI roster + usage contract

> Part I (§1–§5, above) pins the async-consult protocol, the original component prop
> schemas, the agent-visibility contract, the de-demo map, and the roaming cwd. **Part II
> (§6–§10) is the authoritative, complete GenUI + usage contract**: the full component
> roster with exact TypeScript prop interfaces, two NEW components (`gantt`, image-gen
> moodboard), per-component agent-usage rules that become persona text, and the
> think-vs-Codex-vs-foreground tool-selection logic for **both** personas. Where Part II
> restates a Part-I schema it is identical by design (a single audit surface); where it
> *adds* fields (`gantt`, moodboard image-gen) those additions are FIXED and append-only.

Repo facts this part is verified against (so the build/integrate waves don't re-derive
them):

- **Component files exist** at `apps/director/src/renderer/src/canvas/components/`:
  `OptionsPicker.tsx`, `HtmlView.tsx`, `CodePreview.tsx`, `DiagramView.tsx`, `AgentPod.tsx`,
  `Moodboard.tsx`, `ArtifactPreview.tsx`, `Form.tsx`, plus degradation cards
  (`MicDenied`, `ApiKeyMissing`, `RotationFailed`, `CanvasError`) and `HarnessRuleSave`.
  All except `Moodboard`, `Form` ship a `*.test.tsx` snapshot today; **`Moodboard` and
  `gantt` are the test gaps** (Form has `Form.test.ts`).
- **Dispatcher** = `CanvasApp.tsx` `CanvasBody` switch (`apps/director/src/renderer/src/canvas/CanvasApp.tsx:201`).
  Unknown component name → `UnknownComponent`. The switch already has arms for every Part-I
  component; **`gantt` has no arm yet** (Integrate-wave add).
- **Enums** that gate the model's vocabulary: `realtimeToolDefs()` `render_canvas.component`
  enum (`apps/director/src/shared/realtime.ts:101`) and the looser `CanvasComponentName`
  union (`apps/director/src/shared/state.ts:106`). Neither lists `gantt` — both need it
  appended (Integrate wave). All other Part-II names are already present.
- **Image generation** is `imageGenerationTool(options?) → HostedTool`, exported from
  `@openai/agents-openai@0.11.6` and re-exported through `@openai/agents`. It is a **hosted**
  tool (runs server-side, returns base64 image data on the run result), so the Brain must
  **save the bytes to disk** and pass a `file://` path / data-URL to the moodboard — the
  Canvas never receives raw tool output. See §10.
- **Styling seam** = `apps/director/src/renderer/src/canvas/canvas.css` (`.moodboard*`,
  `.artifact*`, `.options-picker*`, `.code-preview*`, `.diagram-view*`, `.html-view*`).
  `AgentPod` is inline-styled (uses `--status-*` / `--text-*` / `--font-*` tokens); **the
  new `gantt` component should likewise use the design tokens** (inline or a `.gantt*`
  block in `canvas.css` — either is acceptable, tokens are the gate).

---

## 6. Complete component roster — exact props, render intent, empty/loading state

Every component is a React `.tsx` in `canvas/components/` and a `case` in `CanvasBody`.
Props arrive as `payload.props` (free-form JSON); each component **casts to its interface
and renders defensively** — tolerate missing/`null`/wrong-typed fields, **never throw**
(the `CanvasErrorBoundary` catches throws, but a graceful empty state is the contract).
Interactive components fire `onRespond(value)` per §2.0; everything else is display-only.

The prop interfaces below are the **single source of truth**. They match the live
component signatures; the value-shapes the model emits in `render_canvas.props` must
conform.

### 6.1 `options_picker` — interactive (EXISTING; solid, minor polish)

```ts
interface OptionsPickerProps {
  title?: string;                                  // eyebrow above the question
  question: string;                                // the prompt being answered
  options: Array<{ id: string; label: string; detail?: string }>;
  sessionId?: string;                              // opaque correlation token (resume picker)
  onSelect?: (optionId: string) => void;           // wired by CanvasBody → onRespond({ option_id })
}
```

- **Render intent:** vertical list of frosted selectable cards — `label` bold, `detail`
  muted sub-line. First click (or voice-resolved pick) plays a ~320ms halo, **locks the
  list** (mirrors `Moodboard`), then surfaces the choice.
- **Response shape (FIXED):** `onRespond({ option_id: id })` — note the **singular**
  `option_id` key (the resume-picker reader `ipcSync.ts handleResumePickerResponse` keys on
  it). `sessionId`, when present, must round-trip so the strip can correlate; the component
  writes it to `data-session-id` and the strip reads `payload.props.sessionId`.
- **Empty/loading:** missing/empty `options` → `"No options to choose from."` (no throw).
- **Polish needs:** none structural. Confirm single-select only (no `allow_multi` in v1).

### 6.2 `html` — display, sandboxed (EXISTING `HtmlView`; the UNIVERSAL ESCAPE HATCH)

```ts
interface HtmlProps {            // component name 'html'; React component HtmlView
  title?: string;                // optional card header
  html: string;                  // model-authored HTML — rendered INERT
}
```

- **Render intent:** the model's `html` string in a **fully-sandboxed `<iframe srcDoc={html} sandbox="" referrerPolicy="no-referrer">`**. This is the **flexible fallback for
  anything no dedicated component covers** — arbitrary layouts, tables, styled text,
  comparison grids, mini landing pages, charts the model hand-rolls in SVG/CSS.
- **Security (FIXED):** `sandbox=""` — **no `allow-scripts`, no `allow-same-origin`**.
  Model HTML does **not** execute JS and cannot reach the app origin/DOM/storage. Inert
  HTML + inline CSS render fine. Never inject the string via `dangerouslySetInnerHTML` into
  the canvas DOM — it must stay iframe-isolated.
- **Empty/loading:** missing/blank `html` → `"Nothing to render."`; the iframe stays inert.
- **Display-only** — no `onRespond`.
- **Persona contract:** the model **must know this exists and reach for it whenever no
  dedicated component fits** (see §7). `html` is what prevents the model from reading
  structure aloud or giving up on a visual.

### 6.3 `code_preview` — display, read-only (EXISTING; solid)

```ts
interface CodePreviewProps {
  title?: string;     // header fallback when path absent
  path?: string;      // file path; preferred header label
  language?: string;  // highlighter hint ('ts'|'tsx'|'py'|…); default plaintext
  code: string;
}
```

- **Render intent:** monospaced, syntax-highlighted, read-only block on a near-black panel
  with a line-number gutter; header shows `path` (preferred) or `title`. Highlighting is a
  dependency-free, **XSS-safe** regex tokenizer applied **after** HTML-escaping (the only
  `dangerouslySetInnerHTML` receives markup generated from escaped text — never raw code).
- **No actions / no diff in v1** (the `codex-pool.ts` fan-in approval renders this
  display-only). Unknown language → escaped, un-colored monospace.
- **Empty/loading:** missing/empty `code` → `"No code to preview yet."`.
- **Display-only** — no `onRespond`.

### 6.4 `diagram` — display (EXISTING `DiagramView`; **polish need: real renderer**)

```ts
interface DiagramProps {              // component name 'diagram'; React component DiagramView
  title?: string;
  kind: 'mermaid' | 'dot';            // dialect discriminator (FIXED field name `kind`)
  source: string;                     // mermaid graph DSL or Graphviz DOT
}
```

- **Render intent:** render `source` as a diagram — `kind:'mermaid'` → mermaid.js,
  `kind:'dot'` → Graphviz (`@viz-js/viz` / `d3-graphviz`). Dark frosted panel.
- **CURRENT STATE / POLISH NEED (DEVIATION, tracked):** the component ships a **source
  fallback only** — a labelled monospaced `<pre>` of the raw `source` — because neither
  `mermaid` nor `@viz-js/viz` is in the dep tree and both are heavy. The component is
  structured so a real renderer drops into `renderDiagram()` without touching props or
  wiring. **Polish target:** add a real renderer (lazy-import to keep it out of the main
  canvas bundle) so a diagram renders as a diagram, not as text. Until then, on any render
  failure the `<pre>` is also the catch-fallback (never throw).
- **Empty/loading:** missing/blank `source` → `"Nothing to diagram yet."`.
- **Display-only** — no `onRespond`.

### 6.5 `agent_pod` — display, live (EXISTING; solid)

```ts
interface AgentPodProps {
  agents: Array<{
    id: string;
    name: string;
    role: string;             // 'Frontend'|'Backend'|'Data'|'Design'|string
    accentColor: string;      // '#RRGGBB' — accent ring
    status: 'spawning'|'working'|'blocked'|'thinking'|'done'|'error'|'killed';
    currentTask: string | null;
    recentFiles: string[];    // mono breadcrumb, cap 3
    trail?: string[];         // optional fading task micro-text history (store `taskTrail`)
  }>;
}
```

- **Render intent:** the live Hive promoted into the Canvas — a vertical column of agent
  nodes (status disc filled by `status`, accent ring by `accentColor`; name in accent color;
  italic `currentTask`; older `trail` entries fade; mono `recentFiles` breadcrumb cap 3).
  Canvas-sized sibling of `HiveStrip`/`AgentRow`; fill map matches `AgentRow.STATUS_FILL`.
- **Live data (FIXED, §3.2):** the `agents[]` field maps **1:1** to `shared/state.ts`
  `Agent` (`taskTrail` → `trail`), so the strip relays `useAgentsOrderedForHive()`
  (`state/selectors.ts:65`) straight through and **re-relays on each agents-slice change**
  (debounce ~120ms) to keep it live. The model may also pass an explicit `agents:[…]`.
- **Empty/loading:** empty `agents` → `"No agents running"`. Malformed/unknown `status`
  falls back to the tertiary-text fill (no throw — covered by `AgentPod.test.tsx`).
- **Display-only** — no `onRespond`.

### 6.6 `moodboard` — interactive (EXISTING; **polish need: generated images, §10**)

```ts
interface MoodboardConcept {
  id: string;
  label: string;
  description: string;
  image_url: string;        // resolved asset URL, data-URL, OR file:// path (see §10)
  palette?: string[];       // optional swatch hexes
}
interface MoodboardProps {
  title?: string;
  concepts: MoodboardConcept[];
  onSelect?: (conceptId: string) => void;   // wired → onRespond({ concept_id })
}
```

- **Render intent:** horizontal tile chooser (3-up). First pick → 500ms halo on the chosen
  tile, others dim, list locks; response surfaces after the halo. Each tile shows the
  `image_url` as a cover plus `label` + `description`.
- **Response shape (FIXED):** `onRespond({ concept_id: id })` (the dispatcher wraps
  `onSelect`).
- **Empty/loading:** no `concepts` → the grid is empty (acceptable; the model should not
  open an empty moodboard). **Polish need:** add a `Moodboard.test.tsx` snapshot (it's the
  one interactive component without a test) and a graceful zero-concepts empty state to
  match the others.
- **§10 extension:** `image_url` accepts a `file://` path or data-URL so **brain-generated**
  concept images render with no extra prop — see §10 for the generation→display contract.

### 6.7 `artifact_preview` — display + optional actions (EXISTING; de-demo'd per §2.6)

```ts
type ArtifactAction = 'ship' | 'iterate' | 'discard';
interface ArtifactPreviewProps {
  title?: string;
  kind?: 'iframe' | 'image' | 'html';
  src?: string;                              // url / data-url for kind iframe|image
  html?: string;                             // model HTML for kind 'html' (sandboxed, no scripts — §6.2)
  notes?: string;
  actions?: ArtifactAction[];                // defaults to all three only when interactive
  onAction?: (a: ArtifactAction) => void;    // wired → onRespond({ action })
}
```

- **Render intent:** the final-reveal artifact card — a framed preview of an iframe URL, an
  image, or sandboxed model HTML, plus optional Ship / Iterate / Discard. Renders
  **strictly from props**; the `MOCK_MIXTAPE` fallback + `localhost:3001` default are
  **deleted** (§2.6, §4). Body precedence: iframe → image → html → empty.
- **Response shape:** `onRespond({ action })` when an action is clicked (only surfaces when
  `onAction` is wired).
- **Empty/loading (FIXED):** no `src` and no `html` → calm `"Nothing to preview yet"` —
  **never** demo tracks. An iframe renders only when `kind==='iframe'` **and** `src` is a
  real URL.

### 6.8 `form` — interactive (EXISTING; solid)

```ts
type FormFieldKind = 'text' | 'password' | 'select';
interface FormField {
  id: string;
  label: string;
  kind: FormFieldKind;
  placeholder?: string;
  defaultValue?: string;
  options?: Array<{ value: string; label: string }>;   // for kind 'select'
  required?: boolean;                                   // gates submit
}
interface FormProps {
  title?: string;
  fields?: FormField[];                                 // defaults to the onboarding triplet
  submitLabel?: string;
  onSubmit?: (values: Record<string, string>) => void;  // wired → onRespond({ values })
}
```

- **Render intent:** a minimal vertical field stack with a single submit; submit stays
  disabled until every `required` field is non-empty. Generic enough for any field list;
  onboarding (`useOnboarding.ts`) supplies the `{ projectPath, voice, apiKey }` triplet.
- **Response shape:** `onRespond({ values })` — the field-id → value map.
- **Empty/loading:** with no `fields` it renders the onboarding triplet (intentional
  default). A caller passing `fields: []` gets a submit-only form (acceptable).
- **Onboarding/cwd note (§5):** `projectPath` is the **optional starting hint**, never a
  jail; copy must frame it as "where to start (you can move me anytime by voice)".

### 6.9 Degradation + ephemeral cards (EXISTING — no change)

`mic_denied`, `api_key_missing` (interactive → `onRespond({ saved })`), `rotation_failed`
(auto-dismiss), `canvas_error`, `harness_rule_save` (auto-fade). Rendered from props;
listed for completeness — out of scope for new work.

---

## 7. Per-component AGENT USAGE rules (persona text)

These one-liners are the **WHEN-to-reach-for-it** rules. They are written to be pasted
**near-verbatim** into the persona tool/Canvas guidance (DIRECTOR_INSTRUCTIONS `# Tools` /
a new `# Canvas — what to show` block, and the BRAIN's `# Visual & frontend design` block),
append-only. The governing principle: **show, don't read aloud** — any time the model would
otherwise speak a list, code, structure, a plan, or a visual, it opens the Canvas instead.

| Component | Reach for it WHEN… |
|---|---|
| `options_picker` | the user must **choose** between a small, discrete set of named options (2–6), and you want the pick back ("pick a direction", "which framework"). Not for free-form input — that's `form`. |
| `moodboard` | giving **visual / aesthetic direction** or showing **generated landing-page / brand imagery** — concepts the user judges by eye. Use it for "show me some looks", and (via §10) for brain-generated concept art. |
| `code_preview` | you need to **show code** — a snippet, a file, a generated function, a diff target. **Never read code aloud.** Always `code_preview`. |
| `diagram` | the answer is a **structure or flow** best seen — architecture, a state machine, a data model, a sequence. `kind:'mermaid'` for flow/sequence/class, `kind:'dot'` for graphs. |
| `gantt` | **planning multi-step / multi-agent work** (who does what, in what order) **and reporting live progress** on it. Open it when you break work into ≥3 steps or dispatch ≥2 agents; re-render it with updated `status`/`nowPct` as work advances. (§9) |
| `agent_pod` | the user asks **"what's happening / show me the team"** and you want the **live Hive on the big surface** (richer than the strip). For a spoken status with no visual, use `list_agents` instead. |
| `artifact_preview` | revealing a **finished artifact** for judgment — a running preview (iframe), a rendered image, or a built page — with optional Ship / Iterate / Discard. |
| `form` | you need **structured typed input** (paths, keys, a few named fields) — onboarding, settings, anything voice would fumble. Not for a single yes/no (just ask) and not for a choice (use `options_picker`). |
| `html` | **anything visual the dedicated components don't cover** — a table, a comparison grid, styled prose, a custom mini-layout, a hand-rolled chart. This is the **universal escape hatch**: when in doubt and a picture beats words, generate `html`. Inert (no JS). |

**Anti-rules (FIXED, both personas):** never read code, file paths, long lists, or a
multi-step plan aloud — render `code_preview` / `agent_pod` / `gantt` / `html`. Don't open
an **empty** component (no `moodboard` with zero concepts, no `gantt` with zero tasks).
Don't open the Canvas for a one-line spoken answer the user only wanted to hear.

---

## 8. Tool-selection logic — think vs Codex vs foreground (BOTH personas)

There are **three execution tiers**. Choosing the right one is the core orchestration
skill; the personas must encode it crisply. The dividing line is **time-to-resolve and
weight**, not topic.

| Tier | Who | Latency | Use for |
|---|---|---|---|
| **FOREGROUND** | Realtime voice (gpt-realtime, this layer) | instant | conversation, quick answers, intent **routing**, **status** (`list_agents`), tool actions the user directly asks for, acknowledgements. |
| **DEEP BRAIN** | gpt-5.5 via `consult_director` (`agent-brain.ts`) | seconds → a few minutes | **shallow-to-medium thinking**, quick experimentation, **light file edits**, **online research via shell**, codebase investigation, design via Pencil. Resolves while the conversation continues. |
| **CODEX sub-agents** | `dispatch_agent_mock` → Codex fleet | **~30 min**, heavy | **long-running heavy execution** — building features, creating **many files**, deep multi-file refactors, parallelizable build-out across agents (Maya/Jin/Cleo/Wren). |

Decision rule, in one line: **answer it yourself if you can; consult the Brain when it
needs real thought, a quick edit, or a look at the code/web; dispatch Codex only when the
work is big, multi-file, or long-running.** Don't dispatch a Codex agent for something the
Brain can resolve in a minute; don't make the Brain hand-build a feature that wants the
Codex fleet.

### 8.1 FOREGROUND persona text (`DIRECTOR_INSTRUCTIONS`, append-only)

Already largely present (the `# Consulting the deep brain` + `# Tools` blocks). The FIXED
guidance to **preserve and sharpen**:

- **Answer directly** — status, acks, simple facts, and any tool the user names (call it).
  Never consult for status (`list_agents`) or for a direct command (just `render_canvas` /
  `dispatch_agent_mock` / `update_harness`).
- **`consult_director`** only for genuine depth — architecture, non-obvious trade-offs,
  multi-step breakdowns, "how should we…?", "which approach…?", or anything a snap answer
  would be glib about. It is **async**: returns a `thinking` ticket, you say one alive line
  ("Let me dig into that — keep talking, I'll fold it in when it lands."), keep talking, and
  the answer arrives later as an unprompted "On <topic>: …" line. **Do not poll/wait.** (§1)
- **`dispatch_agent_mock`** for execution that's **big or long-running** — "build the
  checkout flow", "scaffold the API", parallel work across agents. Returns immediately;
  narrate by agent name (Maya/Jin/Cleo/Wren), never "I". For a quick edit or a look, that's
  the Brain's job (`consult_director`), not a 30-minute Codex run.
- **The split in one breath:** *foreground = talk + route + status; Brain = think, peek,
  small edits, research; Codex = the heavy build.*

### 8.2 DEEP BRAIN persona text (`BRAIN_INSTRUCTIONS`, append-only)

Add an explicit **"# When to do it yourself vs hand to Codex"** block. FIXED guidance:

- **Do it yourself** (you have a full shell + Pencil): investigate the codebase, run
  `git`/`tsc`/tests, do **online research**, make **light/surgical edits**, run quick
  experiments, design visuals in Pencil. You resolve in seconds-to-minutes — that's your
  lane. Investigate before you answer; don't guess.
- **Hand to the Codex fleet** the **heavy, long-running, multi-file execution** — building a
  whole feature, generating many files, a deep refactor, work that parallelizes across
  Maya (frontend) / Jin (backend) / Cleo (data) / Wren (design). Describe the breakdown
  (who does what); the system dispatches them. **Don't hand-build for 30 minutes what the
  fleet should build; don't dispatch the fleet for a one-file fix you can make now.**
- **Surface visuals, don't describe them:** for any design/frontend work use Pencil, then
  screenshot or export and surface it on the Canvas (a `moodboard` of generated concepts —
  §10 — an `artifact_preview`, or `html`). Prefer showing the artifact over narrating it.
- **Output stays a tight 1–3 spoken sentences** (it's narrated aloud); say what you found /
  decided / dispatched in one or two clauses. (Unchanged — preserve.)

---

## 9. NEW component — `gantt` (plan + live progress chart)

A plan/progress chart used for **both** PLANNING multi-step / multi-agent work (who does
what, in what order) **and** showing LIVE PROGRESS. It must re-render cleanly when the same
plan is pushed again with updated `status` / `nowPct` (the model re-issues
`render_canvas('gantt', …)` with the same `task.id`s and new statuses as work advances).

### 9.1 Prop interface (FIXED)

```ts
type GanttStatus = 'planned' | 'running' | 'blocked' | 'done';

interface GanttTask {
  id: string;              // stable across re-renders — drives diffing / layout continuity
  label: string;           // the work item, short ("Wire checkout form")
  owner?: string;          // agent / person ("Maya"); rendered as a small tag
  status: GanttStatus;     // planned | running | blocked | done — drives bar color
  startPct?: number;       // 0..100 — bar left edge as % of the timeline; default 0
  endPct?: number;         // 0..100 — bar right edge; default 100 (or startPct if absent)
  etaLabel?: string;       // free-text ETA / duration ("~30m", "by 4pm") shown at bar end
}

interface GanttProps {
  title?: string;          // card header ("Checkout flow — plan")
  tasks: GanttTask[];      // the rows, top-to-bottom = order
  nowPct?: number;         // 0..100 — position of the "now" marker line; omit to hide
  lanes?: string[];        // optional column/lane headers ("Today","Tomorrow") drawn as gridlines
}
```

Semantics:

- **`status` → bar color (FIXED token map):** `planned` → `--text-tertiary` (faint outline
  bar), `running` → `--status-working` (filled, the active accent — soft neon green),
  `blocked` → `--status-blocked` (amber, gently pulsing), `done` → `--status-done` (solid,
  dimmed). Reuse the same `--status-*` tokens `AgentPod`/`AgentRow` use so a plan and the
  Hive read as one system.
- **`startPct`/`endPct`** position the bar horizontally (percent of the card width). When
  both are absent a task is a full-width row (pure checklist mode); when present it's a true
  timeline. `nowPct` draws a thin vertical "now" line across all rows.
- **`owner`** renders as a small accent tag on the row (when present, tint it with the
  matching agent accent if the owner maps to a known agent name — best-effort, not required).
- **`etaLabel`** renders as muted text at the bar's right edge.
- **`lanes`** (optional) draw faint vertical gridlines + top labels to segment the timeline.

### 9.2 Render intent + states

- **Render intent:** rows top-to-bottom in `tasks` order; each row = `label` (+ `owner`
  tag) on the left, a horizontal status bar positioned by `startPct..endPct`, `etaLabel` at
  the bar end. A `nowPct` marker line and optional `lanes` gridlines overlay the track.
  Dark frosted surface; spring-eased width/position transitions so a status flip animates
  (use `framer-motion` `layout` like `AgentPod`, honoring `useReducedMotion`).
- **Re-render-on-update (FIXED):** keyed by `task.id` so pushing the same plan with new
  statuses **animates in place** (bar color + width + `nowPct` move), not a full remount.
  This is the primary mode — plan first, then the same card narrates progress.
- **Empty/loading:** missing/empty `tasks` → calm `"Nothing planned yet."` (never throw;
  match the other components' empty states).
- **Display-only** — no `onRespond` (a plan/progress chart is informational; selection is
  not part of v1).
- **Defensive:** clamp `startPct`/`endPct`/`nowPct` to `0..100`; tolerate `endPct < startPct`
  (render a min-width bar); unknown `status` → `planned` styling.

### 9.3 Wiring (Integrate wave — see Appendix)

- New file `canvas/components/Gantt.tsx` exporting `Gantt` + `GanttProps`.
- New `CanvasBody` arm: `case 'gantt': return <Gantt {...(payload.props as unknown as GanttProps)} />;`
- Append `'gantt'` to the `render_canvas.component` enum (`shared/realtime.ts realtimeToolDefs()`)
  and to `CanvasComponentName` (`shared/state.ts`).
- Snapshot test `Gantt.test.tsx` (renderToString, vitest node env — mirror
  `AgentPod.test.tsx`): renders multiple tasks; surfaces labels/owners/ETA; status→color
  classes present; empty-tasks empty state; clamps out-of-range pcts without throwing;
  unknown status degrades.
- Persona: the §7 `gantt` usage line into DIRECTOR_INSTRUCTIONS; one BRAIN line ("when you
  break work into steps or dispatch the fleet, show the plan as a gantt and re-push it with
  updated statuses").

---

## 10. NEW capability — image-gen moodboard (generated concept images)

The `moodboard` already accepts `image_url` per concept. The **FIXED extension** is that
those URLs can point at **brain-GENERATED** images, not just bundled assets — so the Brain
can dream up landing-page / brand concepts and surface them for visual judgment.

### 10.1 Generation path (the Brain side)

`imageGenerationTool` is a **hosted** tool (`@openai/agents-openai`, re-exported via
`@openai/agents`): `imageGenerationTool(options?) → HostedTool`. It runs server-side; the
generated image comes back as **base64 image data on the run result**, not as a URL the
Canvas can fetch directly. Therefore the contract is **generate → persist → pass a path**:

1. **Add the tool to the Brain agent.** In `agent-brain.ts getAgent()`, include
   `imageGenerationTool()` in the agent's `tools` array (alongside `shellTool`). The Brain
   may prefer **Pencil** for structured design (per its persona); `imageGenerationTool` is
   for **generative concept art** (mood, texture, hero imagery) where a render beats a
   layout. *(This is the one Brain change §10 implies; flagged as wiring, not done here.)*
2. **Persist the bytes.** When the tool returns image data, the Brain (via its shell or a
   small helper) writes each image to a temp dir — e.g.
   `~/.director/generated/<ts>-<slug>.png` (under `homedir()`, the same trust zone the
   shell already uses). The Brain knows the absolute path it wrote.
3. **Hand paths to the moodboard.** The Brain's consult result drives a
   `render_canvas('moodboard', { concepts:[…] })` where each concept's `image_url` is a
   **`file://<abs path>`** (preferred for already-saved files) **or** a **data-URL**
   (`data:image/png;base64,…`) for small images passed inline. No new moodboard prop is
   needed — `image_url` is the carrier (it already accepts asset URLs / data-URLs; we add
   `file://` + generated data-URLs to its allowed forms).

### 10.2 Display path (the Canvas side) — FIXED prop shape

The moodboard prop shape is **unchanged**; the extension is purely the **accepted forms of
`image_url`**:

```ts
interface MoodboardConcept {
  id: string;
  label: string;
  description: string;
  // FIXED — accepted forms (the §10 extension):
  //   • bundled asset URL      (existing)
  //   • https URL              (existing)
  //   • data:image/...;base64  (inline generated image)
  //   • file:///abs/path.png   (brain-saved generated image)
  image_url: string;
  palette?: string[];
}
```

- The component already renders `image_url` as a CSS `background-image: url(...)`, which
  resolves `file://` and data-URLs in the Electron renderer. **No component code change is
  required** for display — only the documented widening of accepted `image_url` forms and a
  generated-image-friendly empty/loading state (a concept whose image is still being written
  should not break the tile; tolerate a transiently missing/blank `image_url` by showing the
  `label`/`description` over a neutral tile).
- **Loading state (FIXED):** because generation takes seconds, the Brain should push the
  moodboard **only when the images are written** (the consult is async — §1 — so the user
  isn't blocked). If a concept arrives with a not-yet-ready `image_url`, the tile renders the
  text over a neutral placeholder rather than a broken image.

### 10.3 Security / scope

- Generated files live under `~/.director/generated/` (user's machine, same trust model as
  the Brain's shell). No remote fetch is introduced on the Canvas — `file://` and data-URLs
  are local. The iframe-based components (`html`, `artifact_preview` html mode) remain inert
  and unaffected.
- **Renderer file access caveat (flag for Integrate):** confirm the Canvas `BrowserWindow`
  can load `file://` images (sandbox/`webSecurity`/CSP). If `file://` is blocked, the
  fallback is a **data-URL** (the Brain inlines the base64) — which always renders. Spec
  preference: `file://` for anything non-trivial in size; data-URL for small/quick concepts.
  The Integrate wave verifies which path the Canvas window permits and standardizes on it.

---

## Appendix II — WIRING REQUIRED for Part II (Integrate wave)

Part II authors the contract only. The build/integrate waves must connect:

1. **`gantt` component** — new `canvas/components/Gantt.tsx` (`Gantt` + `GanttProps`, §9.1)
   + `Gantt.test.tsx`; new `CanvasBody` arm `case 'gantt'` (`CanvasApp.tsx`); append
   `'gantt'` to the `render_canvas.component` enum (`shared/realtime.ts realtimeToolDefs()`)
   **and** `CanvasComponentName` (`shared/state.ts`).
2. **`diagram` polish** — drop a lazy-imported real renderer into `DiagramView.renderDiagram()`
   (mermaid for `kind:'mermaid'`, `@viz-js/viz` for `kind:'dot'`), keeping the `<pre>` as the
   render-failure fallback. (Deviation today: source-only fallback.)
3. **`moodboard` polish** — add `Moodboard.test.tsx` (snapshot) + a zero-concepts empty
   state; widen `image_url` to accept `file://`/data-URL generated images (§10.2). No prop
   change.
4. **Image-gen Brain wiring** — add `imageGenerationTool()` to the Brain agent's `tools`
   (`agent-brain.ts getAgent()`); persist generated bytes to `~/.director/generated/`; drive
   `render_canvas('moodboard', …)` with `file://`/data-URL `image_url`s (§10.1). Verify the
   Canvas window can load `file://` images; else standardize on data-URL (§10.3).
5. **Persona edits (append-only)** —
   - DIRECTOR_INSTRUCTIONS: a `# Canvas — what to show` block from the §7 table (incl. the
     `gantt` + `html`-escape-hatch lines) and the §8.1 three-tier split; the `gantt` usage
     line. Preserve the chief-of-staff voice + adaptive verbosity + async-consult contract
     verbatim (§1.8 lines already present) — **additions must not flatten the persona.**
   - BRAIN_INSTRUCTIONS: the §8.2 "do-it-yourself vs hand-to-Codex" block; the §7/§9 lines
     about showing plans (`gantt`) and generated concepts (`moodboard` via §10).
6. **Component-file polish (BUILD wave, no dispatcher/enum edits):** the per-component
   render-intent / empty-state expectations in §6 are the acceptance bar — bring each rough
   component up to it (notably `diagram`, `moodboard`).
