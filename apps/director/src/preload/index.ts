import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannel,
  type DirectorBridge,
  type DormantState,
  type HotkeyListener,
} from '../shared/ipc.js';

const api: DirectorBridge = {
  onHotkey(cb: HotkeyListener) {
    const listener = (): void => cb();
    ipcRenderer.on(IpcChannel.HotkeyPressed, listener);
    return () => ipcRenderer.removeListener(IpcChannel.HotkeyPressed, listener);
  },
  requestSummon(): Promise<void> {
    return ipcRenderer.invoke(IpcChannel.RequestSummon);
  },
  getDormantState(): Promise<DormantState> {
    return ipcRenderer.invoke(IpcChannel.GetDormantState);
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('director', api);
  } catch (err) {
    console.error('[director:preload] failed to expose bridge', err);
  }
} else {
  // Non-isolated fallback for dev (contextIsolation: false).
  (window as unknown as { director: DirectorBridge }).director = api;
}
