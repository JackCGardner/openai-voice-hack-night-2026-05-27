/**
 * Codex pool — Electron wrapper around `codex-pool-core.ts`.
 *
 * Adapts the core's callback-based event emission into:
 *   - `mainWindow.webContents.send(IpcChannel.CodexEvent, …)` for the
 *     renderer strip + Hive state machine.
 *   - `ipcMain.handle(IpcChannel.CodexDispatch / CodexAbort, …)` so the
 *     tool-router (renderer-side `tool.call`) can spawn agents.
 *
 * The pure orchestration (semaphore, dispatch state, persona templates,
 * SDK plumbing) lives in `codex-pool-core.ts` so headless callers (the
 * dogfood CLI script, future test harnesses) can drive the same pool
 * without booting Electron.
 *
 * Public API surface is preserved via re-exports — `tool-router.ts`,
 * `main/index.ts`, and any future importer keeps working unchanged.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannel } from '../shared/ipc.js';
import type { AgentId } from '../shared/state.js';
import type { CodexEvent } from '../shared/codex.js';
import {
  dispatchAgentCore,
  abortAgentCore,
  abortAllAgentsCore,
  type DispatchAck,
  type DispatchAgentRequest,
} from './codex-pool-core.js';

// ─── Re-exports for backwards compat ──────────────────────────────────

export type { CodexEvent, CodexEventType } from '../shared/codex.js';
export type {
  DispatchAck,
  DispatchAgentRequest,
} from './codex-pool-core.js';

// ─── Event sink (renderer bridge) ─────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

export function setMainWindow(w: BrowserWindow | null): void {
  mainWindow = w;
}

function emit(event: CodexEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send(IpcChannel.CodexEvent, event);
    } catch (err) {
      console.warn('[codex-pool] emit failed', err);
    }
  }
}

// ─── Dispatch / abort wrappers ────────────────────────────────────────

export function dispatchAgent(
  req: DispatchAgentRequest,
  sessionId: string,
): Promise<DispatchAck> {
  return dispatchAgentCore(req, sessionId, emit);
}

export async function abortAgent(
  agentId: AgentId,
): Promise<{ ok: boolean }> {
  return { ok: abortAgentCore(agentId) };
}

export async function abortAllAgents(): Promise<void> {
  await abortAllAgentsCore();
}

// ─── IPC registration ─────────────────────────────────────────────────

interface DispatchIpcPayload extends DispatchAgentRequest {
  sessionId: string;
}

export function registerCodexPoolIpc(w: BrowserWindow | null): void {
  setMainWindow(w);

  ipcMain.handle(
    IpcChannel.CodexDispatch,
    async (_evt, payload: DispatchIpcPayload): Promise<DispatchAck> => {
      try {
        const { sessionId, ...rest } = payload;
        return await dispatchAgent(rest, sessionId);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    IpcChannel.CodexAbort,
    async (_evt, agentId: AgentId): Promise<{ ok: boolean }> => {
      return abortAgent(agentId);
    },
  );
}
