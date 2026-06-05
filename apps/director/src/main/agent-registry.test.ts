/**
 * Tests for the agent registry (docs/voice-genui-spec.md §3.1).
 *
 * Headless: mocks `electron` (so the side-store's `ipcMain.*` is inert) and
 * stubs `readWorldState` so the registry's mapping/filtering is exercised
 * without disk. Covers: view mapping, defensive coercion of malformed rows,
 * terminal-status filtering, and the `listActiveAgents` read-failure fallback.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../shared/state.js';

vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: class {},
}));

// Stub the side-store world reader so the registry never touches disk.
const readWorldStateMock = vi.fn();
vi.mock('./side-store.js', () => ({
  readWorldState: () => readWorldStateMock(),
}));

import {
  listActiveAgents,
  selectActiveAgents,
  toActiveAgentView,
  toListAgentsItem,
} from './agent-registry.js';

function agent(over: Partial<Agent>): Agent {
  return {
    id: 'maya',
    name: 'Maya',
    role: 'Frontend',
    accentColor: '#E07856',
    status: 'working',
    currentTask: 'wiring the card',
    taskTrail: ['wiring the card'],
    recentFiles: ['src/App.tsx'],
    blocker: null,
    worktreePath: null,
    codexThreadId: null,
    dispatchedAt: 1,
    finishedAt: null,
    ...over,
  };
}

afterEach(() => {
  readWorldStateMock.mockReset();
});

describe('toActiveAgentView', () => {
  it('maps a full agent to the view shape', () => {
    const v = toActiveAgentView(agent({}));
    expect(v).toEqual({
      id: 'maya',
      name: 'Maya',
      role: 'Frontend',
      status: 'working',
      currentTask: 'wiring the card',
      recentFiles: ['src/App.tsx'],
    });
  });

  it('coerces malformed / partial rows to safe defaults (never throws)', () => {
    const v = toActiveAgentView({ id: 'jin' } as Partial<Agent>);
    expect(v.id).toBe('jin');
    expect(v.name).toBe('jin'); // falls back to id
    expect(v.role).toBe('Frontend');
    expect(v.status).toBe('working');
    expect(v.currentTask).toBeNull();
    expect(v.recentFiles).toEqual([]);
  });

  it('falls back to "unknown" id when id is missing', () => {
    expect(toActiveAgentView({} as Partial<Agent>).id).toBe('unknown');
  });

  it('caps recentFiles at 3', () => {
    const v = toActiveAgentView(
      agent({ recentFiles: ['a', 'b', 'c', 'd', 'e'] }),
    );
    expect(v.recentFiles).toEqual(['a', 'b', 'c']);
  });
});

describe('selectActiveAgents', () => {
  it('returns live agents and filters terminal ones', () => {
    const out = selectActiveAgents({
      active_agents: [
        agent({ id: 'maya', status: 'working' }),
        agent({ id: 'jin', status: 'blocked' }),
        agent({ id: 'cleo', status: 'done' }),
        agent({ id: 'wren', status: 'error' }),
        agent({ id: 'zed', status: 'killed' }),
        agent({ id: 'ada', status: 'thinking' }),
      ],
    });
    expect(out.map((a) => a.id).sort()).toEqual(['ada', 'jin', 'maya']);
  });

  it('returns [] for an empty / malformed world view', () => {
    expect(selectActiveAgents({ active_agents: [] })).toEqual([]);
    expect(
      selectActiveAgents({ active_agents: undefined as unknown as Agent[] }),
    ).toEqual([]);
  });
});

describe('listActiveAgents', () => {
  it('reads the side-store world view and maps it', async () => {
    readWorldStateMock.mockResolvedValue({
      active_agents: [agent({ id: 'maya' }), agent({ id: 'jin', status: 'done' })],
    });
    const out = await listActiveAgents();
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('maya');
  });

  it('returns [] when the side-store read throws', async () => {
    readWorldStateMock.mockRejectedValue(new Error('disk gone'));
    expect(await listActiveAgents()).toEqual([]);
  });
});

describe('toListAgentsItem', () => {
  it('narrows the view to the spec wire shape (no id / recentFiles)', () => {
    const item = toListAgentsItem(toActiveAgentView(agent({})));
    expect(item).toEqual({
      name: 'Maya',
      role: 'Frontend',
      status: 'working',
      currentTask: 'wiring the card',
    });
    expect(item).not.toHaveProperty('id');
    expect(item).not.toHaveProperty('recentFiles');
  });
});
