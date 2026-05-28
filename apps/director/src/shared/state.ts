/**
 * Canonical state types for Director, shared across main / preload / renderer.
 *
 * The renderer's Zustand store is the source of truth; main holds an
 * authoritative mirror reconciled via IPC. These types are referenced by both
 * sides and by every IPC payload that carries state data. See:
 *   - docs/state-machine.md (spec)
 *   - docs/ipc-contracts.md (transport)
 *   - docs/architecture.md §2 / §3
 *
 * Keep this file structured-clone-safe: plain interfaces, no functions, no
 * classes. Anything declared here must round-trip cleanly across the
 * Electron IPC boundary.
 */

// ─── Identifiers + primitives ────────────────────────────────────────────

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
  | {
      kind: 'speaking';
      itemId: string;
      phase: 'commentary' | 'final_answer';
      since: number;
    }
  | { kind: 'thinking'; trail: string[]; since: number }
  | { kind: 'hive'; activeAgentId: AgentId | null; since: number }
  | {
      kind: 'escalating';
      agentId: AgentId;
      blocker: string;
      since: number;
    }
  | {
      kind: 'error';
      code: string;
      message: string;
      recoverable: boolean;
      since: number;
    }
  | {
      kind: 'disconnected';
      reason: 'network' | 'auth' | 'rotation-failed';
      since: number;
    };

export type RealtimeStatus =
  | 'idle'
  | 'minting-token'
  | 'connecting'
  | 'live'
  | 'rotating'
  | 'degraded'
  | 'closed';

// ─── Agent ───────────────────────────────────────────────────────────────

export type AgentRole = 'Frontend' | 'Backend' | 'Data' | 'Design' | string;

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
  role: AgentRole;
  /** Hex color literal, e.g. '#7AC0FF'. Forms the "Hive accent ring". */
  accentColor: `#${string}`;
  status: AgentStatus;
  currentTask: string | null;
  /** Ring buffer of recent task micro-text. Cap 8 — see state-machine.md §2. */
  taskTrail: string[];
  /** Cap 3 — Pass 4 Hive layout. */
  recentFiles: string[];
  blocker: string | null;
  /** 0..1, optional UI fill. */
  progress?: number;
  worktreePath: string | null;
  codexThreadId: string | null;
  dispatchedAt: number;
  finishedAt: number | null;
}

// ─── Canvas ──────────────────────────────────────────────────────────────

export type CanvasComponentName =
  | 'moodboard'
  | 'options_picker'
  | 'diagram'
  | 'code_preview'
  | 'form'
  | 'agent_pod'
  | 'artifact_preview'
  | 'html_escape'
  | 'harness_flash';

export interface CanvasComponentProps {
  [key: string]: unknown;
}

export interface CanvasQueueEntry {
  componentId: string;
  component: CanvasComponentName;
  props: CanvasComponentProps;
  interactive: boolean;
}

export interface CanvasState {
  open: boolean;
  phase: 'hidden' | 'opening' | 'open' | 'awaiting-response' | 'dismissing';
  componentId: string | null;
  component: CanvasComponentName | null;
  props: CanvasComponentProps | null;
  interactive: boolean;
  /** setTimeout handle for the 400ms post-response auto-dismiss. */
  dismissTimerId: number | null;
  openedAt: number | null;
  queue: CanvasQueueEntry[];
}

// ─── Harness ─────────────────────────────────────────────────────────────

export interface HarnessRule {
  id: string;
  rule: string;
  why: string;
  timestamp: number;
  scope: 'global' | 'project' | 'task';
  source: 'user-utterance' | 'inferred' | 'system';
}

// ─── Transcript ──────────────────────────────────────────────────────────

export type TranscriptRole = 'user' | 'assistant' | 'system';

export type TranscriptMetadataKind =
  | 'proactive_announcement'
  | 'world-state-brief'
  | 'tool_call'
  | 'tool_result';

export interface TranscriptItem {
  id: string;
  role: TranscriptRole;
  content: string;
  phase?: 'commentary' | 'final_answer';
  timestamp: number;
  realtimeItemId?: string;
  metadata?: { kind?: TranscriptMetadataKind };
}

// ─── Realtime tool definitions (for session.update / mint payload) ───────

export interface RealtimeToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ─── Serializable snapshot (state.snapshotRequest / state.sync) ──────────

/**
 * The portable form of the renderer store — no functions, no setTimeout
 * handles, no live phase enums. Used by main when persisting / replicating.
 */
export interface SerializableStore {
  strip: StripState;
  realtime: {
    status: RealtimeStatus;
    sessionId: string | null;
    micMuted: boolean;
    rotationDueAt: number | null;
  };
  agents: Record<AgentId, Agent>;
  agentOrder: AgentId[];
  canvas: Omit<CanvasState, 'dismissTimerId'>;
  harness: HarnessRule[];
  transcript: TranscriptItem[];
  goal: string | null;
}

// ─── World-state brief (rotation reseed) ─────────────────────────────────

export interface WorldStateBrief {
  harnessRules: string[];
  activeAgents: Array<{
    id: AgentId;
    name: string;
    role: AgentRole;
    status: AgentStatus;
    task: string | null;
  }>;
  goal: string | null;
  lastCanvas: {
    component: CanvasComponentName;
    props: CanvasComponentProps;
    awaitingResponse: boolean;
  } | null;
  recentTranscript: TranscriptItem[];
  elapsedMs: number;
}
