/**
 * Unit tests for the codex.event → side-store agent-record mapping
 * (the list_agents-blind fix). Two layers:
 *
 *   1. `applyCodexEventToAgent` — the PURE mapper: synthetic CodexEvents →
 *      expected `Agent` records (create, update, error/block, finish, backfill).
 *   2. `syncAgentFromCodexEvent` — the stateful wrapper the codex-pool wires
 *      in: asserts it calls `queueAgentWrite` with the upserted record and
 *      threads prior state across successive events.
 *
 * Headless: mocks `electron` (side-store imports `ipcMain`) and stubs
 * `queueAgentWrite` so we assert the persisted record without touching disk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../shared/state.js';
import type { CodexEvent, CodexEventType } from '../shared/codex.js';

vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: class {},
}));

// Stub the side-store writer so the wrapper's persist is observable without FS.
const queueAgentWriteMock = vi.fn<(agent: Agent) => void>();
vi.mock('./side-store.js', () => ({
  queueAgentWrite: (agent: Agent) => queueAgentWriteMock(agent),
}));

import {
  applyCodexEventToAgent,
  syncAgentFromCodexEvent,
  _peekAgentSnapshot,
  _resetAgentSnapshotsForTests,
} from './agent-side-store-sync.js';

const MAYA = 'maya';

function makeEvent<T extends CodexEventType>(
  type: T,
  payload: Record<string, unknown>,
  agentId: string = MAYA,
  at: number = 1000,
): CodexEvent {
  return { agent_id: agentId, type, payload, at };
}

beforeEach(() => {
  _resetAgentSnapshotsForTests();
  queueAgentWriteMock.mockReset();
});

afterEach(() => {
  _resetAgentSnapshotsForTests();
});

// ─── Pure mapper ──────────────────────────────────────────────────────────

describe('applyCodexEventToAgent', () => {
  it('agent_started creates a fresh working record with role-derived accent', () => {
    const a = applyCodexEventToAgent(
      makeEvent('agent_started', {
        name: 'Maya',
        role: 'Frontend',
        task: 'wiring the flip animation',
        worktree: '/tmp/maya',
        branch: 'agents/maya',
      }),
      null,
    );
    expect(a).not.toBeNull();
    expect(a!.id).toBe('maya');
    expect(a!.name).toBe('Maya');
    expect(a!.role).toBe('Frontend');
    expect(a!.status).toBe('working');
    expect(a!.currentTask).toBe('wiring the flip animation');
    expect(a!.taskTrail).toEqual(['wiring the flip animation']);
    expect(a!.recentFiles).toEqual([]);
    expect(a!.blocker).toBeNull();
    expect(a!.worktreePath).toBe('/tmp/maya');
    expect(a!.accentColor).toBe('#E07856'); // Frontend
    expect(a!.dispatchedAt).toBe(1000);
    expect(a!.finishedAt).toBeNull();
  });

  it('thread_started stamps codexThreadId onto the prior record', () => {
    const started = applyCodexEventToAgent(
      makeEvent('agent_started', { name: 'Maya', role: 'Frontend', task: 't' }),
      null,
    );
    const next = applyCodexEventToAgent(
      makeEvent('thread_started', { thread_id: 'th_abc' }),
      started,
    );
    expect(next!.codexThreadId).toBe('th_abc');
    expect(next!.status).toBe('working');
  });

  it('file_change merges changed paths newest-first, deduped, capped at 3', () => {
    let a = applyCodexEventToAgent(
      makeEvent('agent_started', { name: 'Maya', role: 'Frontend', task: 't' }),
      null,
    );
    const fc = (path: string): CodexEvent =>
      makeEvent('file_change', {
        phase: 'item.completed',
        item: { type: 'file_change', changes: [{ path, kind: 'update' }] },
      });
    a = applyCodexEventToAgent(fc('a.ts'), a);
    a = applyCodexEventToAgent(fc('b.ts'), a);
    a = applyCodexEventToAgent(fc('c.ts'), a);
    a = applyCodexEventToAgent(fc('d.ts'), a);
    expect(a!.recentFiles).toEqual(['d.ts', 'c.ts', 'b.ts']);
  });

  it('agent_message (item.completed) updates currentTask + appends trail', () => {
    let a = applyCodexEventToAgent(
      makeEvent('agent_started', {
        name: 'Maya',
        role: 'Frontend',
        task: 'initial',
      }),
      null,
    );
    a = applyCodexEventToAgent(
      makeEvent('agent_message', {
        phase: 'item.completed',
        item: { type: 'agent_message', text: 'wiring the flip' },
      }),
      a,
    );
    expect(a!.currentTask).toBe('wiring the flip');
    expect(a!.taskTrail).toEqual(['initial', 'wiring the flip']);
  });

  it('error sets status=blocked + blocker from the message', () => {
    let a = applyCodexEventToAgent(
      makeEvent('agent_started', { name: 'Jin', role: 'Backend', task: 't' }, 'jin'),
      null,
    );
    a = applyCodexEventToAgent(
      makeEvent('error', { message: 'stripe key missing' }, 'jin'),
      a,
    );
    expect(a!.status).toBe('blocked');
    expect(a!.blocker).toBe('stripe key missing');
  });

  it('agent_finished (natural) → status=done, finishedAt set, summary lands in task', () => {
    let a = applyCodexEventToAgent(
      makeEvent('agent_started', { name: 'Maya', role: 'Frontend', task: 't' }),
      null,
    );
    a = applyCodexEventToAgent(
      makeEvent('agent_finished', { aborted: false, summary: 'shipped' }, MAYA, 2000),
      a,
    );
    expect(a!.status).toBe('done');
    expect(a!.finishedAt).toBe(2000);
    expect(a!.currentTask).toBe('shipped');
    expect(a!.blocker).toBeNull();
  });

  it('agent_finished (aborted) → status=killed', () => {
    let a = applyCodexEventToAgent(
      makeEvent('agent_started', { name: 'Maya', role: 'Frontend', task: 't' }),
      null,
    );
    a = applyCodexEventToAgent(makeEvent('agent_finished', { aborted: true }), a);
    expect(a!.status).toBe('killed');
    expect(a!.finishedAt).toBeTypeOf('number');
  });

  it('agent_hang_suspected stamps a watchdog blocker', () => {
    let a = applyCodexEventToAgent(
      makeEvent('agent_started', { name: 'Maya', role: 'Frontend', task: 't' }),
      null,
    );
    a = applyCodexEventToAgent(
      makeEvent('agent_hang_suspected', { thresholdMs: 60_000 }),
      a,
    );
    expect(a!.blocker).toBe('watchdog: no output 60s');
  });

  // ─── Backfill: a missed agent_started must NOT make the agent invisible ──

  it('backfills a synthetic record when a NON-started event arrives for an unknown id', () => {
    // No prior snapshot (prev = null), and it is NOT agent_started.
    const a = applyCodexEventToAgent(
      makeEvent('file_change', {
        phase: 'item.completed',
        item: { type: 'file_change', changes: [{ path: 'late.ts', kind: 'add' }] },
      }),
      null,
    );
    expect(a).not.toBeNull();
    expect(a!.id).toBe('maya');
    expect(a!.name).toBe('maya'); // id-derived fallback
    expect(a!.role).toBe('Frontend'); // default
    expect(a!.status).toBe('working');
    expect(a!.recentFiles).toEqual(['late.ts']);
  });

  it('backfills then immediately resolves on an agent_finished for an unknown id', () => {
    const a = applyCodexEventToAgent(
      makeEvent('agent_finished', { aborted: false }, 'ghost', 3000),
      null,
    );
    expect(a).not.toBeNull();
    expect(a!.id).toBe('ghost');
    expect(a!.status).toBe('done');
    expect(a!.finishedAt).toBe(3000);
  });

  it('returns prev unchanged for an event with no agent_id', () => {
    const prev = applyCodexEventToAgent(
      makeEvent('agent_started', { name: 'Maya', role: 'Frontend', task: 't' }),
      null,
    );
    const out = applyCodexEventToAgent(
      { agent_id: '', type: 'agent_message', payload: {}, at: 1 } as CodexEvent,
      prev,
    );
    expect(out).toBe(prev);
  });

  it('batch_completed never produces a per-agent record', () => {
    expect(
      applyCodexEventToAgent(
        makeEvent('batch_completed', { batchId: 'b1', worktrees: [] }),
        null,
      ),
    ).toBeNull();
  });
});

// ─── Stateful wrapper (the pool's real caller) ──────────────────────────────

describe('syncAgentFromCodexEvent', () => {
  it('persists the upserted record via queueAgentWrite on agent_started', () => {
    const persisted = syncAgentFromCodexEvent(
      makeEvent('agent_started', { name: 'Maya', role: 'Frontend', task: 't' }),
    );
    expect(persisted).not.toBeNull();
    expect(queueAgentWriteMock).toHaveBeenCalledTimes(1);
    expect(queueAgentWriteMock.mock.calls[0]![0]).toEqual(persisted);
    expect(persisted!.id).toBe('maya');
    expect(persisted!.status).toBe('working');
  });

  it('threads prior state across a full lifecycle (started → message → finished)', () => {
    syncAgentFromCodexEvent(
      makeEvent('agent_started', {
        name: 'Maya',
        role: 'Frontend',
        task: 'initial',
        worktree: '/tmp/maya',
      }),
    );
    syncAgentFromCodexEvent(
      makeEvent('agent_message', {
        phase: 'item.completed',
        item: { type: 'agent_message', text: 'tuning the spring' },
      }),
    );
    const finished = syncAgentFromCodexEvent(
      makeEvent('agent_finished', { aborted: false }, MAYA, 9000),
    );
    // The final persisted record carries the threaded history, not a fresh one.
    expect(finished!.status).toBe('done');
    expect(finished!.finishedAt).toBe(9000);
    expect(finished!.worktreePath).toBe('/tmp/maya'); // carried from create
    expect(finished!.taskTrail).toEqual(['initial', 'tuning the spring']);
    expect(queueAgentWriteMock).toHaveBeenCalledTimes(3);
    // The in-memory mirror matches the last persisted snapshot.
    expect(_peekAgentSnapshot(MAYA)).toEqual(finished);
  });

  it('a missed agent_started still produces a visible record (backfill via wrapper)', () => {
    const persisted = syncAgentFromCodexEvent(
      makeEvent('agent_message', {
        phase: 'item.completed',
        item: { type: 'agent_message', text: 'already working' },
      }),
    );
    expect(persisted).not.toBeNull();
    expect(persisted!.id).toBe('maya');
    expect(persisted!.currentTask).toBe('already working');
    expect(queueAgentWriteMock).toHaveBeenCalledTimes(1);
  });

  it('keeps separate records per agent id', () => {
    syncAgentFromCodexEvent(
      makeEvent('agent_started', { name: 'Maya', role: 'Frontend', task: 'a' }, 'maya'),
    );
    syncAgentFromCodexEvent(
      makeEvent('agent_started', { name: 'Jin', role: 'Backend', task: 'b' }, 'jin'),
    );
    expect(_peekAgentSnapshot('maya')!.role).toBe('Frontend');
    expect(_peekAgentSnapshot('jin')!.role).toBe('Backend');
    expect(_peekAgentSnapshot('jin')!.accentColor).toBe('#4A9E9C');
  });

  it('no write for an event with no agent_id', () => {
    const out = syncAgentFromCodexEvent({
      agent_id: '',
      type: 'agent_message',
      payload: {},
      at: 1,
    } as CodexEvent);
    expect(out).toBeNull();
    expect(queueAgentWriteMock).not.toHaveBeenCalled();
  });
});
