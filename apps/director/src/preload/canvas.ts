/**
 * Canvas-window preload — narrow IPC surface for the Canvas BrowserWindow's
 * renderer. Lives separately from the Strip preload (W1) so the two surfaces
 * evolve independently.
 *
 * Exposes `window.electron.ipcRenderer` (and a `director.canvasIpc` mirror)
 * with on / removeListener / send constrained to canvas channels.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CanvasIpcChannel } from '../shared/canvas-ipc.js';

type Listener = (...args: unknown[]) => void;
type IpcListener = (event: IpcRendererEvent, ...args: unknown[]) => void;

const SAFE_CHANNELS = new Set<string>(Object.values(CanvasIpcChannel));

/**
 * Per-channel registry of (caller listener) → (wrapped listener we passed to
 * ipcRenderer). Lets removeListener target the SPECIFIC wrapped listener
 * instead of dropping every subscriber on the channel — prior implementation
 * called ipcRenderer.removeAllListeners(channel), which would deregister
 * any other subscriber on the same channel.
 */
const wrappers = new Map<string, WeakMap<Listener, IpcListener>>();

function trackWrapper(channel: string, original: Listener, wrapped: IpcListener): void {
  let perChannel = wrappers.get(channel);
  if (!perChannel) {
    perChannel = new WeakMap();
    wrappers.set(channel, perChannel);
  }
  perChannel.set(original, wrapped);
}

function popWrapper(channel: string, original: Listener): IpcListener | undefined {
  const perChannel = wrappers.get(channel);
  const wrapped = perChannel?.get(original);
  perChannel?.delete(original);
  return wrapped;
}

const api = {
  on(channel: string, listener: Listener): void {
    if (!SAFE_CHANNELS.has(channel)) {
      console.warn(`[canvas:preload] refusing on(${channel})`);
      return;
    }
    const wrapped: IpcListener = (event, ...args) => listener(event, ...args);
    trackWrapper(channel, listener, wrapped);
    ipcRenderer.on(channel, wrapped);
  },
  removeListener(channel: string, listener: Listener): void {
    if (!SAFE_CHANNELS.has(channel)) return;
    const wrapped = popWrapper(channel, listener);
    if (wrapped) {
      ipcRenderer.removeListener(channel, wrapped);
    }
  },
  send(channel: string, ...args: unknown[]): void {
    if (!SAFE_CHANNELS.has(channel)) {
      console.warn(`[canvas:preload] refusing send(${channel})`);
      return;
    }
    ipcRenderer.send(channel, ...args);
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', { ipcRenderer: api });
    contextBridge.exposeInMainWorld('director', { canvasIpc: api });
  } catch (err) {
    console.error('[canvas:preload] failed to expose bridge', err);
  }
} else {
  (window as unknown as { electron: { ipcRenderer: typeof api } }).electron = {
    ipcRenderer: api,
  };
}
