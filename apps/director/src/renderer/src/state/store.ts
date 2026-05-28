import { create } from 'zustand';

/**
 * Minimal renderer state for the boilerplate.
 * Larger state-machine design is the architecture agent's job.
 */
interface DirectorState {
  dormant: boolean;
  lastHotkeyAt: number | null;
  pingHotkey: () => void;
  setDormant: (dormant: boolean) => void;
}

export const useDirectorStore = create<DirectorState>((set) => ({
  dormant: true,
  lastHotkeyAt: null,
  pingHotkey: () => set({ lastHotkeyAt: Date.now() }),
  setDormant: (dormant) => set({ dormant }),
}));
