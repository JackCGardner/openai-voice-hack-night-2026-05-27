/**
 * Snapshot / behavior tests for AgentPod (docs/voice-genui-spec.md §2.5).
 *
 * Rendered via `react-dom/server.renderToString` under the vitest `node`
 * environment (no jsdom), matching canvas-degrade.test.tsx. Asserts the pod
 * renders multiple agents without crashing, surfaces each agent's name /
 * current task / files, and shows a calm empty state for an empty roster.
 */

import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { AgentPod, type AgentPodAgent } from './AgentPod';

const THREE_AGENTS: AgentPodAgent[] = [
  {
    id: 'a1',
    name: 'Iris',
    role: 'Frontend',
    accentColor: '#7AC0FF',
    status: 'working',
    currentTask: 'wiring the canvas dispatcher',
    recentFiles: ['CanvasApp.tsx', 'AgentPod.tsx'],
    trail: ['read spec', 'scaffolding'],
  },
  {
    id: 'a2',
    name: 'Dax',
    role: 'Backend',
    accentColor: '#58D68D',
    status: 'blocked',
    currentTask: 'waiting on an API key',
    recentFiles: ['tool-router.ts'],
  },
  {
    id: 'a3',
    name: 'Mara',
    role: 'Data',
    accentColor: '#E8A95C',
    status: 'done',
    currentTask: null,
    recentFiles: [],
    trail: ['migrated schema'],
  },
];

describe('AgentPod', () => {
  it('renders three agents without crashing', () => {
    const html = renderToString(<AgentPod agents={THREE_AGENTS} />);
    expect(html).toContain('Iris');
    expect(html).toContain('Dax');
    expect(html).toContain('Mara');
  });

  it('surfaces role, current task, and files breadcrumb', () => {
    const html = renderToString(<AgentPod agents={THREE_AGENTS} />);
    expect(html).toContain('FRONTEND');
    expect(html).toContain('wiring the canvas dispatcher');
    // recentFiles breadcrumb joins with ' · '.
    expect(html).toContain('CanvasApp.tsx');
    expect(html).toContain('AgentPod.tsx');
  });

  it('falls back to the latest trail entry when currentTask is null', () => {
    // Mara has currentTask: null but a trail — the headline should use it.
    const html = renderToString(<AgentPod agents={[THREE_AGENTS[2]!]} />);
    expect(html).toContain('migrated schema');
  });

  it('renders a calm empty state for an empty roster', () => {
    const html = renderToString(<AgentPod agents={[]} />);
    expect(html).toContain('No agents running');
  });

  it('does not crash on a malformed / unknown status', () => {
    const html = renderToString(
      <AgentPod
        agents={[
          {
            id: 'x',
            name: 'Ghost',
            role: 'Design',
            accentColor: '#FFFFFF',
            // @ts-expect-error — exercise the runtime status-fill fallback
            status: 'totally-unknown',
            currentTask: 'pondering',
            recentFiles: [],
          },
        ]}
      />,
    );
    expect(html).toContain('Ghost');
    expect(html).toContain('pondering');
  });
});
