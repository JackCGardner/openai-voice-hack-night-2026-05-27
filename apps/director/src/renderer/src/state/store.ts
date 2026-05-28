import { create } from 'zustand';

/**
 * Minimal renderer state for W2's Strip + Hive scaffolding.
 * W3 will overwrite with the canonical state-machine store; this is a stub.
 */

export type StripState =
  | 'dormant'
  | 'listening'
  | 'speaking'
  | 'thinking'
  | 'hive'
  | 'escalating';

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done';
export type AgentAccent = 'maya' | 'jin' | 'cleo' | 'wren';

export interface Agent {
  id: string;
  name: string;
  role: string;
  accent: AgentAccent;
  status: AgentStatus;
  trail: string;
  files: string;
}

interface DirectorState {
  stripState: StripState;
  setStripState: (s: StripState) => void;

  agents: Agent[];
  setAgents: (agents: Agent[]) => void;

  thinkingTrail: string[];
  setThinkingTrail: (lines: string[]) => void;

  audioInputStream: MediaStream | null;
  setAudioInputStream: (s: MediaStream | null) => void;
  audioOutputStream: MediaStream | null;
  setAudioOutputStream: (s: MediaStream | null) => void;

  lastHotkeyAt: number | null;
  pingHotkey: () => void;
}

const stubAgents: Agent[] = [
  {
    id: 'maya',
    name: 'Maya',
    role: 'FRONTEND',
    accent: 'maya',
    status: 'working',
    trail: 'wiring the flip animation',
    files: 'PlaylistCard.tsx · CoverArt.tsx',
  },
  {
    id: 'jin',
    name: 'Jin',
    role: 'BACKEND',
    accent: 'jin',
    status: 'blocked',
    trail: 'awaiting Stripe key direction',
    files: '',
  },
  {
    id: 'cleo',
    name: 'Cleo',
    role: 'DATA',
    accent: 'cleo',
    status: 'working',
    trail: 'writing Mixtape schema',
    files: 'lib/schema.ts',
  },
  {
    id: 'wren',
    name: 'Wren',
    role: 'DESIGN',
    accent: 'wren',
    status: 'done',
    trail: 'holographic tokens locked',
    files: '',
  },
];

const stubThinkingTrail = [
  'weighing two approaches',
  'the user mentioned dark mode',
  'and the harness says no gradients',
  'so I should go with the matte direction',
];

export const useDirectorStore = create<DirectorState>((set) => ({
  stripState: 'dormant',
  setStripState: (stripState) => set({ stripState }),

  agents: stubAgents,
  setAgents: (agents) => set({ agents }),

  thinkingTrail: stubThinkingTrail,
  setThinkingTrail: (thinkingTrail) => set({ thinkingTrail }),

  audioInputStream: null,
  setAudioInputStream: (audioInputStream) => set({ audioInputStream }),
  audioOutputStream: null,
  setAudioOutputStream: (audioOutputStream) => set({ audioOutputStream }),

  lastHotkeyAt: null,
  pingHotkey: () => set({ lastHotkeyAt: Date.now() }),
}));
