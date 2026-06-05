/**
 * Tests for the agent tools (docs/voice-genui-spec.md §3).
 *
 * Headless: mocks `electron` (side-store `ipcMain.*` inert) + stubs the
 * agent-registry read so `handleListAgents` is exercised without disk. The
 * real-dispatch path injects a fake `DispatchAgentDriver`, so no Codex SDK /
 * Electron is touched. Covers: tool-def shape, handler return shape, the
 * read-failure degrade, the `DIRECTOR_REAL_AGENTS` flag, dispatch forwarding,
 * validation, and target-repo resolution.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallRequest } from '../shared/ipc.js';
import type { ActiveAgentView } from './agent-registry.js';

vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: class {},
}));

const listActiveAgentsMock = vi.fn<() => Promise<ActiveAgentView[]>>();
vi.mock('./agent-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-registry.js')>();
  return {
    ...actual,
    listActiveAgents: () => listActiveAgentsMock(),
  };
});

import {
  dispatchAgentReal,
  getListAgentsOutput,
  handleListAgents,
  listAgentsToolDef,
  resolveTargetRepo,
  type DispatchAgentDriver,
} from './agent-tools.js';

const req = (callId: string): ToolCallRequest => ({
  callId,
  name: 'dispatch_agent_mock',
  args: {},
  realtimeItemId: 'item-1',
});

const view = (over: Partial<ActiveAgentView>): ActiveAgentView => ({
  id: 'maya',
  name: 'Maya',
  role: 'Frontend',
  status: 'working',
  currentTask: 'wiring the card',
  recentFiles: [],
  ...over,
});

afterEach(() => {
  listActiveAgentsMock.mockReset();
});

describe('listAgentsToolDef', () => {
  it('is a zero-arg function tool named list_agents', () => {
    expect(listAgentsToolDef.type).toBe('function');
    expect(listAgentsToolDef.name).toBe('list_agents');
    expect(listAgentsToolDef.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });
});

describe('getListAgentsOutput / handleListAgents', () => {
  it('returns the narrow { agents } wire shape', async () => {
    listActiveAgentsMock.mockResolvedValue([
      view({ id: 'maya' }),
      view({ id: 'jin', name: 'Jin', role: 'Backend', status: 'blocked', currentTask: null }),
    ]);
    const out = await getListAgentsOutput();
    expect(out).toEqual({
      agents: [
        { name: 'Maya', role: 'Frontend', status: 'working', currentTask: 'wiring the card' },
        { name: 'Jin', role: 'Backend', status: 'blocked', currentTask: null },
      ],
    });
  });

  it('handleListAgents wraps the output in an ok ToolCallResponse', async () => {
    listActiveAgentsMock.mockResolvedValue([view({})]);
    const res = await handleListAgents(req('c1'));
    expect(res.ok).toBe(true);
    expect(res.callId).toBe('c1');
    if (res.ok) {
      expect(res.output).toEqual({
        agents: [{ name: 'Maya', role: 'Frontend', status: 'working', currentTask: 'wiring the card' }],
      });
      expect(typeof res.latencyMs).toBe('number');
    }
  });

  it('degrades to an ok empty list if the registry read rejects', async () => {
    listActiveAgentsMock.mockRejectedValue(new Error('boom'));
    const res = await handleListAgents(req('c2'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.output).toEqual({ agents: [] });
  });
});

describe('dispatchAgentReal', () => {
  const args = {
    agentId: 'maya',
    name: 'Maya',
    role: 'Frontend' as const,
    task: 'build the strip',
    targetRepo: '/Users/dev/project',
  };

  it('forwards the request to the injected driver with sessionId and maps the ack', async () => {
    const dispatch = vi.fn<DispatchAgentDriver>(
      async () => ({ ok: true, agentId: 'maya', worktree: '/wt/maya', branch: 'agent/maya' }),
    );
    const res = await dispatchAgentReal(args, 'session-1', dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [passedReq, passedSession] = dispatch.mock.calls[0]!;
    expect(passedReq).toEqual({
      agentId: 'maya',
      name: 'Maya',
      role: 'Frontend',
      task: 'build the strip',
      targetRepo: '/Users/dev/project',
    });
    expect(passedSession).toBe('session-1');
    expect(res).toEqual({
      ok: true,
      agent_id: 'maya',
      worktree: '/wt/maya',
      branch: 'agent/maya',
    });
  });

  it('passes optional baseBranch + batchId through when present', async () => {
    const dispatch = vi.fn<DispatchAgentDriver>(async () => ({
      ok: true as const,
      agentId: 'jin',
      worktree: '/wt/jin',
      branch: 'b',
    }));
    await dispatchAgentReal(
      { ...args, agentId: 'jin', baseBranch: 'develop', batchId: 'batch-9' },
      's',
      dispatch,
    );
    expect(dispatch.mock.calls[0]![0]).toMatchObject({
      baseBranch: 'develop',
      batchId: 'batch-9',
    });
  });

  it('surfaces a failed ack as { ok:false }', async () => {
    const dispatch: DispatchAgentDriver = async () => ({ ok: false, error: 'already running' });
    const res = await dispatchAgentReal(args, 's', dispatch);
    expect(res).toEqual({ ok: false, error: 'already running' });
  });

  it('rejects missing task / targetRepo / session before dispatching', async () => {
    const dispatch = vi.fn();
    expect(await dispatchAgentReal({ ...args, task: '' }, 's', dispatch as unknown as DispatchAgentDriver)).toEqual({
      ok: false,
      error: 'missing task prompt',
    });
    expect(await dispatchAgentReal({ ...args, targetRepo: '' }, 's', dispatch as unknown as DispatchAgentDriver)).toEqual({
      ok: false,
      error: 'missing targetRepo',
    });
    expect(await dispatchAgentReal(args, '', dispatch as unknown as DispatchAgentDriver)).toEqual({
      ok: false,
      error: 'no active session',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('resolveTargetRepo (cwd-first precedence — finish-spec §B.1)', () => {
  const orig = process.env.DIRECTOR_PROJECT_ROOT;
  afterEach(() => {
    if (orig === undefined) delete process.env.DIRECTOR_PROJECT_ROOT;
    else process.env.DIRECTOR_PROJECT_ROOT = orig;
  });

  it('explicit wins over everything (brainCwd, env, home)', () => {
    process.env.DIRECTOR_PROJECT_ROOT = '/Users/dev/env';
    expect(
      resolveTargetRepo({
        explicit: '/Users/dev/explicit',
        brainCwd: '/Users/dev/brain',
        home: '/Users/dev',
      }),
    ).toBe('/Users/dev/explicit');
  });

  it('brainCwd wins over DIRECTOR_PROJECT_ROOT + home when no explicit', () => {
    process.env.DIRECTOR_PROJECT_ROOT = '/Users/dev/env';
    expect(
      resolveTargetRepo({ brainCwd: '/Users/dev/brain', home: '/Users/dev' }),
    ).toBe('/Users/dev/brain');
  });

  it('prefers DIRECTOR_PROJECT_ROOT when set and no explicit/brainCwd', () => {
    process.env.DIRECTOR_PROJECT_ROOT = '/Users/dev/foo';
    expect(resolveTargetRepo({ home: '/Users/dev' })).toBe('/Users/dev/foo');
  });

  it('falls back to the home dir when nothing else is set', () => {
    delete process.env.DIRECTOR_PROJECT_ROOT;
    expect(resolveTargetRepo({ home: '/Users/dev' })).toBe('/Users/dev');
  });

  it('ignores empty-string explicit/brainCwd (treats them as unset)', () => {
    delete process.env.DIRECTOR_PROJECT_ROOT;
    expect(
      resolveTargetRepo({ explicit: '', brainCwd: '', home: '/Users/dev' }),
    ).toBe('/Users/dev');
  });
});

describe('dispatchAgentReal — useWorktree threading (finish-spec §B.3)', () => {
  const base = {
    agentId: 'maya',
    name: 'Maya',
    role: 'Frontend' as const,
    task: 'build the strip',
    targetRepo: '/Users/dev/project',
  };

  it('threads useWorktree:true through to the driver when opted in', async () => {
    const dispatch = vi.fn<DispatchAgentDriver>(async () => ({
      ok: true as const,
      agentId: 'maya',
      worktree: '/wt/maya',
      branch: 'b',
    }));
    await dispatchAgentReal({ ...base, useWorktree: true }, 's', dispatch);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ useWorktree: true });
  });

  it('omits useWorktree from the request when not opted in (shared default)', async () => {
    const dispatch = vi.fn<DispatchAgentDriver>(async () => ({
      ok: true as const,
      agentId: 'maya',
      worktree: '/wt/maya',
      branch: 'b',
    }));
    await dispatchAgentReal(base, 's', dispatch);
    expect(dispatch.mock.calls[0]![0]).not.toHaveProperty('useWorktree');
  });
});
