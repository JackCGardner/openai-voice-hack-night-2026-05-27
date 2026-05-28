# Director — State Machine Spec (W3)

Canonical Zustand store shape, actions, transition rules, persistence, and selectors. This document is **implementable as-is** by W3. It descends from `architecture.md` §2 / §3 and the Pass 2 interaction matrix in `ux-design.md`. Code blocks are tight; semantics live in prose.

The renderer holds the source of truth. Main mirrors via IPC (`state.*` channels in `ipc-contracts.md`). All commits go through typed actions in `apps/director/renderer/state/commands.ts` — never raw `set` from a component.

---

## 1. Discriminated unions and primitives

```ts
export type AgentId = string;

export type StripStateKind =
  | 'dormant'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'thinking'
  | 'hive'
  | 'escalating'
  | 'error'
  | 'disconnected';

export type StripState =
  | { kind: 'dormant' }
  | { kind: 'connecting'; attempt: number; since: number }
  | { kind: 'listening'; mode: 'tap' | 'hold'; since: number }
  | { kind: 'speaking'; itemId: string; phase: 'commentary' | 'final_answer'; since: number }
  | { kind: 'thinking'; trail: string[]; since: number }
  | { kind: 'hive'; activeAgentId: AgentId | null; since: number }
  | { kind: 'escalating'; agentId: AgentId; blocker: string; since: number }
  | { kind: 'error'; code: string; message: string; recoverable: boolean; since: number }
  | { kind: 'disconnected'; reason: 'network' | 'auth' | 'rotation-failed'; since: number };

export type RealtimeStatus =
  | 'idle'
  | 'minting-token'
  | 'connecting'
  | 'live'
  | 'rotating'
  | 'degraded'
  | 'closed';
```

## 2. Agent

```ts
export type AgentStatus =
  | 'spawning'
  | 'working'
  | 'blocked'
  | 'thinking'
  | 'done'
  | 'error'
  | 'killed';

export interface Agent {
  id: AgentId;
  name: string;
  role: 'Frontend' | 'Backend' | 'Data' | 'Design' | string;
  accentColor: `#${string}`;
  status: AgentStatus;
  currentTask: string | null;
  taskTrail: string[];
  recentFiles: string[];
  blocker: string | null;
  progress?: number;
  worktreePath: string | null;
  codexThreadId: string | null;
  dispatchedAt: number;
  finishedAt: number | null;
}
```

`taskTrail` is a ring buffer (cap 8) — older entries shift off when new ones arrive. `recentFiles` is capped at 3 (Pass 4 Hive layout).

## 3. Canvas

```ts
export interface CanvasComponentProps {
  [key: string]: unknown;
}

export type CanvasComponentName =
  | 'moodboard'
  | 'options_picker'
  | 'diagram'
  | 'code_preview'
  | 'form'
  | 'agent_pod'
  | 'artifact_preview'
  | 'html_escape';

export interface CanvasState {
  open: boolean;
  phase: 'hidden' | 'opening' | 'open' | 'awaiting-response' | 'dismissing';
  componentId: string | null;
  component: CanvasComponentName | null;
  props: CanvasComponentProps | null;
  interactive: boolean;
  dismissTimerId: number | null;
  openedAt: number | null;
  queue: Array<{
    componentId: string;
    component: CanvasComponentName;
    props: CanvasComponentProps;
    interactive: boolean;
  }>;
}
```

`dismissTimerId` is the renderer's `setTimeout` handle for the 400ms post-response auto-dismiss. Replaced (cleared) on every canvas mutation.

## 4. Harness

```ts
export interface HarnessRule {
  id: string;
  rule: string;
  why: string;
  timestamp: number;
  scope: 'global' | 'project' | 'task';
  source: 'user-utterance' | 'inferred' | 'system';
}
```

## 5. Transcript

```ts
export interface TranscriptItem {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  phase?: 'commentary' | 'final_answer';
  timestamp: number;
  realtimeItemId?: string;
  metadata?: { kind?: 'proactive_announcement' | 'world-state-brief' | 'tool_call' | 'tool_result' };
}
```

In-memory cap: last 200 items. Full log lives on disk in `transcript.jsonl`.

## 6. Store

```ts
export interface Store {
  strip: StripState;
  realtime: {
    status: RealtimeStatus;
    sessionId: string | null;
    micMuted: boolean;
    rotationDueAt: number | null;
  };
  agents: Record<AgentId, Agent>;
  agentOrder: AgentId[];
  canvas: CanvasState;
  harness: HarnessRule[];
  transcript: TranscriptItem[];
  goal: string | null;

  summon: (mode: 'tap' | 'hold') => void;
  mute: () => void;
  setListening: (mode: 'tap' | 'hold') => void;
  setSpeaking: (itemId: string, phase: 'commentary' | 'final_answer') => void;
  setThinking: () => void;
  appendThinkingTrail: (line: string) => void;
  enterHive: (activeAgentId?: AgentId | null) => void;
  exitHive: () => void;
  addAgent: (agent: Agent) => void;
  updateAgent: (id: AgentId, patch: Partial<Agent>) => void;
  blockAgent: (id: AgentId, blocker: string) => void;
  resolveAgent: (id: AgentId, resumeTask?: string) => void;
  completeAgent: (id: AgentId, summary?: string) => void;
  failAgent: (id: AgentId, error: string) => void;
  openCanvas: (args: {
    componentId: string;
    component: CanvasComponentName;
    props: CanvasComponentProps;
    interactive: boolean;
  }) => void;
  dismissCanvas: (componentId?: string) => void;
  submitCanvasResponse: (componentId: string, value: unknown) => void;
  addHarnessRule: (rule: HarnessRule) => void;
  appendTranscript: (item: TranscriptItem) => void;
  setRealtimeStatus: (status: RealtimeStatus, meta?: { sessionId?: string; rotationDueAt?: number }) => void;
  setError: (code: string, message: string, recoverable: boolean) => void;
  recoverFromError: () => void;
  setDisconnected: (reason: 'network' | 'auth' | 'rotation-failed') => void;
  reconnect: () => void;
}
```

### Action semantics (one-liners)

- `summon(mode)` — user hotkey; transitions strip to `listening` if realtime is `live`, otherwise queues a one-shot replay after `live`.
- `mute()` — sets `realtime.micMuted = true`; if strip was `listening`, drops it to whatever was beneath (`dormant` or `hive`).
- `setListening(mode)` — strip → `{ kind: 'listening', mode }`; unmutes mic.
- `setSpeaking(itemId, phase)` — strip → `speaking`; stores the Realtime item id so barge-in can `conversation.item.truncate` cleanly.
- `setThinking()` — strip → `thinking` with empty trail; used when gpt-5.5 consult begins.
- `appendThinkingTrail(line)` — pushes onto the `thinking` trail (cap 6 lines, FIFO drop).
- `enterHive(activeAgentId?)` — strip → `hive`; preserves underlying agent state; called when work is dispatched and AI is silent.
- `exitHive()` — strip → `dormant` when all agents are `done` and AI silent.
- `addAgent(agent)` — registers a new agent, appends to `agentOrder`, side-effect: strip → `hive` if currently `dormant`.
- `updateAgent(id, patch)` — partial merge; if `patch.currentTask` provided, also pushes onto `taskTrail`.
- `blockAgent(id, blocker)` — sets status to `blocked`; strip → `escalating` with that agent.
- `resolveAgent(id, resumeTask?)` — status back to `working`; strip leaves `escalating` if no other agents are blocked.
- `completeAgent(id, summary?)` — status `done`, sets `finishedAt`.
- `failAgent(id, error)` — status `error`, populates `blocker` with the error text; strip → `escalating`.
- `openCanvas({...})` — if canvas already `open`, queues; otherwise opens directly and sets `phase: 'opening'` → `'open'` after spring.
- `dismissCanvas(componentId?)` — clears the canvas (or just the one matching id); fires queued next item if any.
- `submitCanvasResponse(componentId, value)` — fires `canvas_response` tool-call IPC, then sets a 400ms dismiss timer (unless orchestrator re-renders first).
- `addHarnessRule(rule)` — prepends to `harness[]`; triggers brief Canvas flash (Pass 3 3B-1) via a one-shot `harness_flash` canvas open + auto-dismiss at 1.2s.
- `appendTranscript(item)` — pushes to `transcript[]`, capped at 200, drops oldest.
- `setRealtimeStatus(status, meta?)` — updates `realtime.status`; mirrors to strip (`connecting` → strip `connecting`, `degraded` → strip `disconnected`).
- `setError(code, message, recoverable)` — strip → `error`; recoverable errors auto-clear via `recoverFromError`.
- `setDisconnected(reason)` — strip → `disconnected`; sets `realtime.status = 'degraded'`.

## 7. State-transition rules (legality matrix)

Actions are **rejected** (no-op + dev-mode console warning) if the current `strip.kind` is not in the allowed set. W3 enforces this in `commands.ts` via a guard helper.

| Action | Allowed from `strip.kind` |
|---|---|
| `summon` | `dormant`, `hive`, `error`, `disconnected` (when reconnected) |
| `setListening` | `dormant`, `speaking` (barge-in), `hive`, `thinking` (barge-in) |
| `setSpeaking` | `listening`, `thinking`, `hive`, `dormant` (proactive announcement) |
| `setThinking` | `listening`, `speaking`, `hive` |
| `enterHive` | `dormant`, `listening`, `speaking`, `thinking` |
| `addAgent` | any except `disconnected`, `error` |
| `blockAgent` | requires agent exists; any strip state |
| `openCanvas` | any except `disconnected` |
| `submitCanvasResponse` | requires `canvas.open === true` and `componentId` matches |
| `dismissCanvas` | requires `canvas.open === true` |
| `addHarnessRule` | any except `disconnected`, `error` |
| `reconnect` | only from `disconnected` |
| `recoverFromError` | only from `error` with `recoverable === true` |

**Invariants** (asserted on every state commit):

- `strip.kind === 'escalating'` implies at least one agent has `status === 'blocked' || status === 'error'`.
- `canvas.phase === 'awaiting-response'` implies `canvas.interactive === true`.
- `realtime.status === 'live'` implies `realtime.sessionId !== null`.
- `agentOrder` contains exactly the keys of `agents`.

## 8. Persistence (side store)

Per `architecture.md` §3, the renderer store is mirrored to disk via main. Cadence:

| Slice | File | Cadence |
|---|---|---|
| `harness` | `~/.director/sessions/<id>/harness.json` | Atomic write on every `addHarnessRule` |
| `agents` (per agent) | `~/.director/sessions/<id>/agents/<id>.json` | Atomic write on every status transition |
| `transcript` | `~/.director/sessions/<id>/transcript.jsonl` | Append per `appendTranscript` |
| `canvas` (last) | `~/.director/sessions/<id>/canvas.last.json` | Debounced 500ms after `openCanvas` / `dismissCanvas` |
| Full snapshot | `~/.director/sessions/<id>/state.snapshot.json` | Debounced 1.5s; force-flush on quit and rotation |
| `goal` | `~/.director/sessions/<id>/meta.json` | Atomic write on goal change |

**Not persisted**: `strip`, `realtime.*`, `canvas.queue`, `canvas.dismissTimerId`. These are session-volatile and rebuilt on resume.

On resume (Pass 3 3C-1), main calls IPC `state.hydrate` with the restored slices. The renderer initializes strip to `dormant` and realtime to `idle` regardless of prior values.

## 9. Selectors

Exposed from `apps/director/renderer/state/selectors.ts` as Zustand hooks. Memoized.

```ts
useStrip(): StripState;
useStripKind(): StripStateKind;
useAgents(): Agent[];
useAgent(id: AgentId): Agent | undefined;
useAgentsByStatus(status: AgentStatus): Agent[];
useAgentsOrderedForHive(): Agent[];
useCanvas(): CanvasState;
useIsCanvasOpen(): boolean;
useHarnessRules(): HarnessRule[];
useRecentTranscript(n: number): TranscriptItem[];
useRealtimeStatus(): RealtimeStatus;
useIsAnyAgentBlocked(): boolean;
useCurrentBlocker(): { agent: Agent; blocker: string } | null;
useGoal(): string | null;
useCanSummon(): boolean;
useHasActiveWork(): boolean;
```

**Hive ordering** (`useAgentsOrderedForHive`): blocked → working → thinking → spawning → done → error → killed; within each group, oldest `dispatchedAt` first. Pass 1 §Hive matches this.

**`useCurrentBlocker`**: returns the topmost blocked agent (highest priority for escalation narration). If multiple, the one with the earliest `dispatchedAt` wins.

**`useCanSummon`**: `true` iff `realtime.status === 'live'` and `strip.kind !== 'error'`.

**`useHasActiveWork`**: any agent in `working | thinking | spawning | blocked`.

## 10. Middleware

Zustand store composes three middlewares in order:

1. **`immer`** — drafts.
2. **`subscribeWithSelector`** — for `ipcSync.ts` to subscribe to per-slice changes and push patches to main.
3. **`devtools`** (dev only) — Redux DevTools integration; action names match command function names.

No `persist` middleware — persistence is owned by main, not the renderer.
