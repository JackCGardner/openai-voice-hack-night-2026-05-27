# Director — Contracts

> **Version**: 2026-05-27.2
> **Status**: Source of truth for cross-worker integration. Every agent prompt MUST point at this doc. Every contract change is a commit that updates the version above.

This file is the single shared boundary between workers. If two workers are about to touch the same shape, this is where they agree on it BEFORE writing code. The hackathon retrospective made the diagnosis: subsystems worked in isolation; the integration boundary failed because no canonical contract existed. This is that document.

**Doc vs. code:** this doc describes the **canonical contracts + principles**. The authoritative *full enumeration* of every channel and type lives in:
- `apps/director/src/shared/ipc.ts` — `IpcChannel` enum + all payload interfaces (strip + main IPC)
- `apps/director/src/shared/canvas-ipc.ts` — `CanvasIpcChannel` enum + canvas-window IPC
- `apps/director/src/shared/state.ts` — all state types (Agent, StripState, etc.)
- `apps/director/src/shared/realtime.ts` — Realtime types + `DIRECTOR_INSTRUCTIONS`

When the doc and code disagree, the rule is: **proposing a contract change = a doc commit FIRST, then the code change.** If you find code that drifts from the doc, file a `docs(contracts): clarify <name>` to bring the doc in line, or a `docs(contracts): change <name>` if the code is wrong.

---

## 0. How agents use this doc

Every dispatch prompt includes a `## Contracts` section that links to specific sections of this file by anchor (`docs/contracts.md § 3.2 — tool.call IPC`). Workers read those sections before writing code.

Workers MUST NOT silently invent contracts that aren't here. If a contract is missing, the worker:
1. Names what they think it should be
2. Adds it to this doc as a proposal commit (`docs(contracts): propose <name>`)
3. Pushes, then writes the code

Two workers ending up with different shapes for the same channel = a coordination bug. This doc prevents it.

---

## 1. Process model

```
┌──────────────────────────────────────────────────────────────┐
│  Electron main process                                       │
│  ─ token mint, OpenAI API key, dotenv                        │
│  ─ tray icon + global hotkey                                 │
│  ─ Realtime tool router (intent dispatch)                    │
│  ─ Codex SDK process manager (Phase 4)                       │
│  ─ gpt-5.5 planner client (Phase 3)                          │
│  ─ Side store on disk (harness, decisions, transcript)       │
│  ─ Canvas BrowserWindow lifecycle                            │
└──────────────────────────────────────────────────────────────┘
        ▲     │ IPC (typed channels)
        │     ▼
┌──────────────────────────────────────────────────────────────┐
│  Preload (contextBridge)                                     │
│  ─ window.director.realtime.*                                │
│  ─ window.director.tool.*                                    │
│  ─ window.director.state.*                                   │
│  ─ window.director.canvas.*  (canvas window only)            │
└──────────────────────────────────────────────────────────────┘
        ▲     │
        │     ▼
┌──────────────────────────────────────────────────────────────┐
│  Renderer (React)                                            │
│  ─ RealtimeClient (WebRTC peer + data channel)               │
│  ─ Zustand store (canonical state)                           │
│  ─ Strip + Canvas UI components                              │
│  ─ Sim driver (timer-based agent progression)                │
└──────────────────────────────────────────────────────────────┘
```

**Constraint:** OPENAI_API_KEY lives only in main. Renderer receives short-lived ephemeral Realtime tokens minted on demand.

---

## 2. Shared types

All shared types live in `apps/director/src/shared/`. Importing from this directory is the canonical way to use a type — never redeclare locally.

### 2.1 `Agent` (state.ts)
```ts
export type AgentRole = 'frontend' | 'backend' | 'data' | 'design';
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'error';
export interface Agent {
  id: string;                  // stable per session, e.g. 'maya'
  name: string;                // display name 'Maya'
  role: AgentRole;
  accent: string;              // hex color, no token (Pass 4 identity table)
  status: AgentStatus;
  trail: string;               // italic micro-text shown under name
  files: string[];             // last 3 file paths touched
  blocker?: string;            // populated when status === 'blocked'
  progress?: number;           // 0–1 optional
  startedAt?: number;          // ms epoch
}
```

### 2.2 `StripState` (state.ts)
```ts
export type StripStateKind =
  | 'dormant' | 'connecting' | 'listening' | 'speaking' | 'thinking'
  | 'hive' | 'escalating' | 'error' | 'disconnected';

export type StripState =
  | { kind: 'dormant' }
  | { kind: 'connecting' }
  | { kind: 'listening'; mode: 'tap' | 'hold'; since: number }
  | { kind: 'speaking'; itemId: string; phase: 'commentary' | 'final_answer'; since: number }
  | { kind: 'thinking'; trail: string[]; since: number }
  | { kind: 'hive'; activeAgentId: string | null; since: number }
  | { kind: 'escalating'; agentId: string; blocker: string; since: number }
  | { kind: 'error'; message: string }
  | { kind: 'disconnected' };
```

### 2.3 `CanvasState` (state.ts)
```ts
export interface CanvasState {
  open: boolean;
  componentId?: string;         // orchestrator-generated, correlates render → response
  component?: string;           // 'moodboard' | 'artifact_preview' | 'harness_rule_save' | ...
  props?: Record<string, unknown>;
  awaitingResponse: boolean;
  callId?: string;              // ties to original Realtime tool call
}
```

### 2.4 `HarnessRule` (state.ts)
```ts
export interface HarnessRule {
  rule: string;
  why: string;
  timestamp: number;
}
```

### 2.5 `TranscriptItem` (state.ts)
```ts
export interface TranscriptItem {
  role: 'user' | 'assistant' | 'system';
  text: string;
  phase?: 'commentary' | 'final_answer';   // per gpt-realtime-2 §preamble
  timestamp: number;
  itemId?: string;
}
```

### 2.6 `Mixtape` (examples/mixtape/lib/schema.ts)
```ts
export interface Track {
  title: string;
  artist: string;
  runtime: string;             // 'M:SS'
}
export interface Mixtape {
  id: string;                  // short share id
  vibe: string;                // user's freetext mood
  tracks: Track[];
  coverUrl?: string;           // pre-gen image or generated
  createdAt: number;
}
```

### 2.7 `RealtimeEphemeralToken` (realtime.ts)
```ts
export interface RealtimeEphemeralToken {
  value: string;
  expiresAt: number;           // ms epoch
}
```

---

## 3. IPC channels

Channel names are **canonical strings**. The full enum is the authoritative list — this table covers the **core canonical channels every worker needs to know** plus naming conventions. Never use string literals — always import from the enum.

**Files**:
- `apps/director/src/shared/ipc.ts` exports the `IpcChannel` const + all payload type interfaces (Strip + main IPC surface)
- `apps/director/src/shared/canvas-ipc.ts` exports `CanvasIpcChannel` separately (Canvas BrowserWindow has its own preload + bridge)

**Naming convention** (apply to all new channels):
- Modern: `<domain>.<action>` (`tool.call`, `state.patch`, `realtime.sessionUpdate`)
- Domains in use: `realtime · tool · state · hotkey · mic · audio · app · window · canvas · ask`
- **Legacy carve-out**: four `director:*` channels predate the convention (`director:hotkey-pressed`, `director:get-dormant-state`, `director:request-summon`, `director:realtime-mint-token`). They keep their wire strings to avoid breaking the W1 scaffold. Don't add new `director:*` channels.

**Envelope shape** for invoke responses: `IpcAck<T> = { ok: true; ...T } | { ok: false; error: string }`.

### Core canonical channels (subset)

| Channel | Direction | Payload type | Trigger | Consumer |
|---|---|---|---|---|
| `director:realtime-mint-token` (legacy) | invoke renderer→main | `RealtimeMintTokenRequest` → `RealtimeMintTokenResponse` | RealtimeClient.connect() | main: mintEphemeralToken() |
| `realtime.sessionUpdate` | invoke renderer→main | `RealtimeSessionUpdatePayload` | mid-session reconfig | main: forwards to Realtime API |
| `realtime.rotationReady` | send main→renderer | `RotationReadyPayload` | 55-min rotation primed | renderer: World State Brief swap |
| `tool.call` | invoke renderer→main, then main→renderer broadcast | `ToolCallRequest` → `ToolCallResponse` | Realtime function_call.done event | main: tool-router |
| `tool.result` | send main→renderer | `ToolResultPayload` | tool-router completes | renderer: realtime client (for round-trip back to Realtime) |
| `canvas.render` | send (both directions accepted) | `CanvasRenderPayload` | tool-router OR dev hotkey | canvas window renderer |
| `canvas.dismiss` | send | `CanvasDismissPayload` | tool-router OR user gesture | canvas window |
| `canvas.user_response` | send canvas→main | `CanvasUserResponsePayload` | user clicks tile / button | main: relays to renderer + Realtime |
| `state.patch` | send main→renderer | `StatePatchPayload` | main needs to mutate renderer state | renderer: ipcSync.ts |
| `hotkey.pressed` | send main→renderer | (none) | global Hyper-Space pressed | renderer: App.tsx |
| `mic.status` | send renderer→main | `MicStatusPayload` | mic mode changes | main: updates tray icon |
| `ask.show` | send main→renderer | `AskShowPayload` | tool-router handling ask_user | renderer: shows prompt |
| `ask.answer` | send renderer→main | `AskAnswerPayload` | user answers ask prompt | main: resolves ask_user promise |
| `audio.cue` | send main→renderer | `AudioCuePayload` | sim/state needs to play a cue | renderer: audio module |
| `app.quit` | send renderer→main | (none) | tray menu Quit | main: app.quit() |
| `strip.resize` | invoke renderer→main | `StripResizeRequest` → `StripResizeResponse` | stripState changes | main: setBounds with animate |

### 3.1 `ToolCallRequest` / `ToolCallResponse` (canonical shape)

```ts
export type ToolName = 'render_canvas' | 'dispatch_agent_mock' | 'ask_user' | 'update_harness' | 'consult_director';

export interface ToolCallRequest {
  callId: string;              // Realtime's function-call ID
  name: ToolName;
  args: Record<string, unknown>;
  realtimeItemId: string;
}

export interface ToolCallResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}
```

### 3.2 `CanvasRenderPayload`
```ts
export interface CanvasRenderPayload {
  component: string;           // see § 4 for valid names
  props: Record<string, unknown>;
  componentId?: string;        // for canvas_response correlation
  callId?: string;             // ties to originating tool call
  autoDismissMs?: number;      // optional auto-fade
}
```

### 3.3 `CanvasUserResponsePayload`
```ts
export interface CanvasUserResponsePayload {
  componentId: string;
  callId?: string;
  value: unknown;              // shape varies by component (see § 4)
}
```

---

## 4. Realtime tool definitions

These are the tools the Realtime session is told about via `session.update`. Schemas here are the source of truth — `tools` array in session.update mirrors this.

### 4.1 `render_canvas`
```jsonc
{
  "name": "render_canvas",
  "description": "Open the GenUI Canvas with a typed component.",
  "parameters": {
    "type": "object",
    "required": ["component"],
    "properties": {
      "component": { "type": "string", "enum": ["moodboard", "options_picker", "code_preview", "form", "artifact_preview", "harness_rule_save", "agent_pod"] },
      "props": { "type": "object" },
      "component_id": { "type": "string" }
    }
  }
}
```
**Response shape from user**: `{ value: ComponentSpecific }` via canvas.user_response.
- `moodboard` → `{ concept_id: string }`
- `options_picker` → `{ option_ids: string[] }`
- `artifact_preview` → `{ action: 'ship' | 'iterate' | 'discard' }`
- `harness_rule_save` → `{ dismissed: true, reason: 'auto-fade' }`

### 4.2 `dispatch_agent_mock`
```jsonc
{
  "name": "dispatch_agent_mock",
  "parameters": {
    "type": "object",
    "required": ["name", "role", "task"],
    "properties": {
      "name": { "type": "string" },
      "role": { "type": "string", "enum": ["frontend", "backend", "data", "design"] },
      "task": { "type": "string" }
    }
  }
}
```
**Behavior**: adds agent to store with status:'working', trail=task. First call starts the sim (Phase 4: spawns a real Codex subprocess).

### 4.3 `ask_user`
```jsonc
{
  "name": "ask_user",
  "parameters": {
    "type": "object",
    "required": ["question"],
    "properties": {
      "question": { "type": "string" },
      "options": { "type": "array", "items": { "type": "string" } }
    }
  }
}
```
**Behavior**: Director speaks the question; awaits user voice or click; returns `{ answer: string }`. 60s timeout.

### 4.4 `update_harness`
```jsonc
{
  "name": "update_harness",
  "parameters": {
    "type": "object",
    "required": ["rule", "why"],
    "properties": {
      "rule": { "type": "string" },
      "why": { "type": "string" }
    }
  }
}
```
**Behavior**: appends to harness.json on disk, triggers `harness_rule_save` Canvas flash, returns `{ ok: true, harness_count: number }`.

### 4.5 `consult_director` (Phase 3)
```jsonc
{
  "name": "consult_director",
  "parameters": {
    "type": "object",
    "required": ["prompt"],
    "properties": {
      "prompt": { "type": "string" },
      "context": { "type": "object" }
    }
  }
}
```
**Behavior**: calls gpt-5.5 via Responses API, streams reasoning summary back as Realtime audio narration. Returns `{ summary: string, decisions: string[] }`.

---

## 5. State machine

Canonical Zustand store: `apps/director/src/renderer/src/state/store.ts` exports `useStore`. Full shape (per state-machine.md):

```ts
interface Store {
  strip: StripState;
  mic: { muted: boolean; mode: 'idle' | 'tap-open' | 'hold-open' };
  agents: Record<string, Agent>;
  canvas: CanvasState;
  thinkingTrail: string[];
  harness: HarnessRule[];
  transcript: TranscriptItem[];
  realtimeStatus: 'idle' | 'minting' | 'getting-mic' | 'connecting' | 'connected' | 'closed' | 'error';

  // Actions
  summon: (mode: 'tap' | 'hold') => void;
  mute: () => void;
  setListening: (mode: 'tap' | 'hold') => void;
  setSpeaking: (itemId: string, phase: 'commentary' | 'final_answer') => void;
  setThinking: () => void;
  appendThinkingTrail: (line: string) => void;
  enterHive: () => void;
  addAgent: (a: Omit<Agent, 'status' | 'startedAt'> & { task: string }) => void;
  updateAgent: (id: string, patch: Partial<Agent>) => void;
  blockAgent: (id: string, blocker: string) => void;
  resolveAgent: (id: string, trail?: string) => void;
  completeAgent: (id: string, files?: string) => void;
  failAgent: (id: string, err: string) => void;
  openCanvas: (component: string, props: object, componentId?: string, callId?: string) => void;
  dismissCanvas: () => void;
  submitCanvasResponse: (value: unknown) => void;
  addHarnessRule: (rule: HarnessRule) => void;
  appendTranscript: (item: TranscriptItem) => void;
  setRealtimeStatus: (s: Store['realtimeStatus']) => void;
}
```

**Legal-transition rule**: actions guard against illegal states (e.g., `setListening` only valid from dormant/speaking/thinking/hive). If called from a wrong state, action no-ops + logs.

---

## 6. Side store

Lives at `~/.director/sessions/<session-id>/`. Atomic writes (write to `.tmp`, rename).

| File | Schema | Updated by |
|---|---|---|
| `harness.json` | `HarnessRule[]` | tool-router on update_harness |
| `decisions.jsonl` | one decision per line `{ at, kind, payload }` | sim + tool-router |
| `agents/<agent-id>.json` | `Agent` snapshot | sim on every patch (debounced 100ms) |
| `transcript.jsonl` | one `TranscriptItem` per line | realtime client on each event |
| `world-state.json` | derived view: `{ active_agents, harness, current_task, last_canvas }` | rebuilt before Realtime session rotation (Phase 6) |

---

## 7. DOM events (renderer-internal)

Custom events on `window` for renderer-internal pub/sub.

| Event | Payload (in `detail`) | Fired by | Listened by |
|---|---|---|---|
| `director:escalation` | `{ agent_id, blocker, suggested_question }` | sim on blockAgent | App.tsx → Realtime injection |
| `director:harness-saved` | `{ rule, count }` | store.addHarnessRule | tray badge updater |
| `director:tool-resolved` | `{ callId, result }` | tool-router | log subscribers |

---

## 8. File ownership

Each path has one owning role. Cross-role edits require the doc to update first.

| Path | Owner role | Notes |
|---|---|---|
| `apps/director/src/main/*` | **MAIN** | Electron main process |
| `apps/director/src/preload/*` | **MAIN** | Bridges — main owns these |
| `apps/director/src/renderer/src/realtime/*` | **VOICE** | WebRTC client + hooks |
| `apps/director/src/renderer/src/state/*` | **STATE** | Zustand store + selectors + sim |
| `apps/director/src/renderer/src/components/*` | **UI** | Strip + AgentRow + chat UI |
| `apps/director/src/renderer/src/canvas/*` | **CANVAS** | Canvas window UI |
| `apps/director/src/renderer/src/styles/*` | **UI** | globals.css + tokens |
| `apps/director/src/shared/*` | **shared** | Two-step rule: doc commit before code |
| `apps/director/src/renderer/src/assets/*` | **CANVAS** | Pre-gen images |
| `examples/mixtape/*` | **MIXTAPE** | Demo target |
| `docs/*` | **docs** | Read by all, edited by orchestrator |

**Role codes** for dispatch prompts: `MAIN / VOICE / STATE / UI / CANVAS / MIXTAPE`.

---

## 9. Forbidden patterns

### 9.1 macOS-reserved keyboard shortcuts (NEVER bind globally)
- `⌘Space` — Spotlight
- `⌃Space` — Input source
- `⌘⇧Space` — Character viewer (most setups; usable in dev but unreliable)
- `⌘⇧3 / ⌘⇧4 / ⌘⇧5 / ⌘⇧6` — Screenshot tools
- `⌘⌥M` — Window minimize
- `⌘W` — Close window
- `⌘Q` — Quit
- `⌘H / ⌘⌥H` — Hide / Hide others
- `F1–F12` — Function keys (many remapped by OS to brightness/volume)

**Use Hyper chord** `Control+Alt+Cmd+<letter>` — unbound by default. Example: `⌃⌥⌘M` for Moodboard, `⌃⌥⌘Space` for summon (instead of `⌘⇧Space`).

### 9.2 Electron BrowserWindow flag conflicts
- `frame: false` + `titleBarStyle: 'hidden'` → traffic lights leak on macOS. Use only one.
- `type: 'panel'` requires explicit `closable: false` to remove the red close dot.
- `transparent: true` requires `body { background: transparent; }` in CSS or the renderer fills white.
- `sandbox: true` + non-`.cjs` preload extension can silently break `contextBridge.exposeInMainWorld` — verify preload runs via top-of-file `console.log('[preload] loaded')`.

### 9.3 Styling
- Never use hex literals in components. Reference CSS vars via Tailwind utilities (`text-text-primary`, `bg-status-working`) or `$variable-name` in inline styles.
- Never use linear `transition`. All animation goes through Framer Motion springs.

### 9.4 Imports
- Use `@shared/...` or relative imports — never deep `../../../../`.
- Never import from `src/main/*` in renderer code or vice versa. Cross-process = IPC only.

---

## 10. Verification protocol (every worker's DoD)

Every dispatch task ends with this block:

```
## Verify (must pass before pushing)
1. App launches: `pnpm --filter director dev` → no console errors
2. Trigger the code path you added (specific click / hotkey / event)
3. Open devtools, confirm:
   - window.director exists (if you touched preload)
   - The expected store state / IPC event / DOM event fires
   - No red errors in console or main-process logs
4. If UI-touching: take a screenshot. Compare to the Pencil frame referenced in the prompt (use mcp__pencil__get_screenshot if available).
5. Run `pnpm --filter director typecheck` and `pnpm --filter director build` — both clean.
6. Only then: git add → commit → push.
```

**This is non-negotiable.** Workers who skip the integration-boundary verification create the exact failure mode that broke the hackathon.

---

## 11. Versioning + change protocol

Every contract change is a commit. Commit message format:
- `docs(contracts): propose <name>` — adding a new contract
- `docs(contracts): change <name>` — modifying an existing one
- `docs(contracts): clarify <name>` — non-breaking wording fix

After any change, bump the version line at top of this file (`Version: YYYY-MM-DD.N`).

Workers `git pull` and re-read this file at the start of every task. If the version they read matches the version they reference in their work, contracts are aligned. If not, they stop and re-orient.

---

## 12. Agent prompt template

Every dispatch prompt MUST use this structure:

```markdown
🎯 GOAL (one line): <concrete observable outcome>

## Required reading
- docs/contracts.md § <specific sections by anchor>
- docs/<other-doc>.md § <section>
- apps/director/src/<file>.ts (read first to mirror conventions)

## Contracts referenced
- IPC channel: `<channel-name>` § 3.X
- Type: `<TypeName>` § 2.X
- Tool: `<tool-name>` § 4.X

## File boundaries
CAN touch: <list of paths>
CANNOT touch: <list of paths owned by other roles>

## Forbidden patterns
- (References § 9 of contracts.md plus task-specific)

## Tasks (ship each as separate commit + push)
1. <task name>
   - What: <one line>
   - Where: <file path>
   - How: <2-3 sentences with code sketch if needed>
2. <next task>

## Verify (DoD per § 10 of contracts.md)
1-6. <verbatim from § 10>

## STOP_IF
- If you complete scope before budget, STOP. Do not pad work.
- If contracts in § X conflict with what you're about to write, STOP and propose a contract change first.

## Commit rules
- No co-signing (per CLAUDE.md).
- `git add → commit → push` after each task.
- App must launch after every commit.
```

---

## Appendix A — Quick reference for hackathon-era code

Code already exists for most of § 2 + § 3. Pointers:

- `apps/director/src/shared/state.ts` — types from § 2
- `apps/director/src/shared/ipc.ts` — IpcChannel enum + payload types from § 3
- `apps/director/src/shared/realtime.ts` — DIRECTOR_INSTRUCTIONS persona + token types
- `apps/director/src/shared/canvas-ipc.ts` — canvas-specific channel constants
- `apps/director/src/main/tool-router.ts` — § 4 dispatch logic
- `apps/director/src/renderer/src/state/store.ts` — § 5 store
- `apps/director/src/renderer/src/state/sim.ts` — agent simulator (§ 7 escalation event source)

If any of these drift from this doc, the doc wins. File a contract-change commit and align the code.
