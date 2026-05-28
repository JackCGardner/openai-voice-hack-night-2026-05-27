/**
 * ChatSurface — the full conversational chrome (header + transcript +
 * agent sidebar + composer + demo buttons). Used in the secondary
 * "Show Chat (debug)" window opened from the tray menu.
 *
 * Pure presentational: receives the live RealtimeClient + chat state
 * from App.tsx so the Realtime → store bridge wired in App.tsx keeps
 * driving a single peer instance regardless of which surface is mounted.
 */

import { type FormEvent, type JSX } from 'react';
import { useStore } from '../state/store';
import { startMixtapeDemo, resolveJinBlocker } from '../state/sim';
import type { Agent } from '../../../shared/state';
import type {
  RealtimeClientStatus,
  MicMode,
} from '../realtime/client';
import { devToolCall } from '../lib/toolBridge';

export type ChatMessage = { role: 'user' | 'assistant'; text: string };

const matteVinylUrl = new URL('../assets/matte-vinyl.png', import.meta.url).toString();
const cassetteUrl = new URL('../assets/cassette.png', import.meta.url).toString();
const holographicUrl = new URL('../assets/holographic.png', import.meta.url).toString();
const tokyoNeonUrl = new URL('../assets/tokyo-neon.png', import.meta.url).toString();

function agentAccent(agent: Agent): string {
  const key = `${agent.id} ${agent.name}`.toLowerCase();
  if (key.includes('maya')) return 'var(--accent-maya)';
  if (key.includes('jin')) return 'var(--accent-jin)';
  if (key.includes('cleo')) return 'var(--accent-cleo)';
  if (key.includes('wren')) return 'var(--accent-wren)';
  return agent.accentColor;
}

function agentStatusFill(agent: Agent): string {
  if (agent.status === 'blocked' || agent.status === 'error') {
    return 'var(--status-blocked)';
  }
  if (agent.status === 'done' || agent.status === 'killed') {
    return 'var(--status-done)';
  }
  return 'var(--status-working)';
}

function agentTrail(agent: Agent): string {
  if (agent.status === 'blocked' && agent.blocker) return agent.blocker;
  return agent.currentTask ?? agent.taskTrail[agent.taskTrail.length - 1] ?? agent.status;
}

function statusTone(status: string): string {
  if (status === 'connected') {
    return 'border-status-working/40 bg-status-working/15 text-status-working';
  }
  if (status === 'error') {
    return 'border-status-error/40 bg-status-error/15 text-status-error';
  }
  if (status === 'connecting' || status === 'minting' || status === 'getting-mic') {
    return 'border-status-blocked/40 bg-status-blocked/15 text-status-blocked';
  }
  return 'border-border-subtle bg-white/5 text-text-secondary';
}

function showMoodboardPreset(): void {
  void devToolCall('render_canvas', {
    component_id: `chat-moodboard-${Date.now()}`,
    component: 'moodboard',
    props: {
      title: 'Card material',
      concepts: [
        {
          id: 'matte-vinyl',
          label: 'Matte Vinyl',
          description: 'Premium, monochrome, calm',
          image_url: matteVinylUrl,
        },
        {
          id: 'cassette',
          label: 'Cassette',
          description: 'Translucent amber, warm 80s',
          image_url: cassetteUrl,
        },
        {
          id: 'holographic',
          label: 'Holographic',
          description: 'Iridescent foil, playful',
          image_url: holographicUrl,
        },
      ],
    },
  });
}

function showArtifactPreset(): void {
  void devToolCall('render_canvas', {
    component_id: `chat-artifact-${Date.now()}`,
    component: 'artifact_preview',
    props: {
      title: 'Mixtape',
      notes: 'Tokyo Neon · 6 tracks',
      mixtape: {
        vibe: 'late-night drive through Tokyo neon',
        coverUrl: tokyoNeonUrl,
        tracks: [
          { title: 'Midnight Driver', artist: 'Akira Vance', runtime: '4:12' },
          { title: 'Velvet Apartment', artist: 'Noémie Hara', runtime: '3:48' },
          { title: 'Neon Rain', artist: 'Sable Sound', runtime: '5:02' },
          { title: 'Hyperreal', artist: 'Yoko & The Visa', runtime: '4:31' },
          { title: 'Lights From The Tower', artist: 'CHROMERIDER', runtime: '3:55' },
          { title: 'Akihabara Sunrise', artist: 'Aoi Tanaka', runtime: '4:24' },
        ],
      },
      actions: ['ship', 'iterate', 'discard'],
    },
  });
}

export interface ChatSurfaceProps {
  realtimeStatus: RealtimeClientStatus;
  micMode: MicMode;
  onToggleMic: () => void;
  messages: ChatMessage[];
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  input: string;
  onChangeInput: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function ChatSurface({
  realtimeStatus,
  micMode,
  onToggleMic,
  messages,
  messagesEndRef,
  input,
  onChangeInput,
  onSubmit,
}: ChatSurfaceProps): JSX.Element {
  const agentsById = useStore((s) => s.agents);
  const agentOrder = useStore((s) => s.agentOrder);
  const orderedAgentIds = new Set(agentOrder);
  const agents = agentOrder
    .map((id) => agentsById[id])
    .filter((agent): agent is Agent => Boolean(agent))
    .concat(Object.values(agentsById).filter((agent) => !orderedAgentIds.has(agent.id)));

  const isMicOpen = micMode === 'tap-open' || micMode === 'hold-open';

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0E0D14] font-sans text-white">
      <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center justify-between border-b border-border-subtle bg-[#0E0D14]/95 px-6">
        <h1 className="text-xl font-semibold tracking-normal text-text-primary">Director</h1>
        <span
          className={`rounded-full border px-3 py-1 text-xs font-medium ${statusTone(
            realtimeStatus,
          )}`}
        >
          {realtimeStatus}
        </span>
      </header>

      <main className="flex min-h-0 flex-1 flex-row" data-no-drag>
        <section className="flex min-w-0 flex-1 flex-col">
          <div
            className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
            role="log"
            aria-live="polite"
            aria-label="Conversation"
          >
            <div className="flex flex-col gap-3">
              {messages.map((message, index) => {
                const isUser = message.role === 'user';
                return (
                  <div
                    key={`${message.role}-${index}`}
                    className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[75%] whitespace-pre-wrap rounded-lg border px-4 py-3 text-sm leading-6 shadow-sm select-text ${
                        isUser
                          ? 'border-accent-maya/80 bg-accent-maya/10 text-text-primary'
                          : 'border-accent-jin/80 bg-accent-jin/10 text-text-primary'
                      }`}
                    >
                      {message.text}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          </div>
        </section>

        <aside className="w-72 shrink-0 border-l border-border-subtle bg-surface-base px-4 py-5">
          <div className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-text-tertiary">
            Agents
          </div>
          <div className="flex flex-col gap-2">
            {agents.length === 0 ? (
              <div className="rounded-lg border border-border-subtle px-3 py-4 text-sm text-text-tertiary">
                No agents yet
              </div>
            ) : (
              agents.map((agent) => {
                const fill = agentStatusFill(agent);
                return (
                  <div
                    key={agent.id}
                    className="rounded-lg border border-border-subtle bg-surface-elevated px-3 py-3"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          background: fill,
                          boxShadow: `0 0 0 1px ${fill}`,
                        }}
                        aria-hidden
                      />
                      <span
                        className="min-w-0 truncate text-sm font-semibold"
                        style={{ color: agentAccent(agent) }}
                      >
                        {agent.name}
                      </span>
                    </div>
                    <div className="mt-2 pl-4 text-xs leading-5 text-text-secondary italic">
                      {agentTrail(agent)}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>
      </main>

      <footer
        className="sticky bottom-0 z-10 shrink-0 border-t border-border-subtle bg-[#0E0D14]/95 px-5 py-4"
        data-no-drag
      >
        <form className="flex flex-wrap items-center gap-2" onSubmit={onSubmit}>
          <input
            className="min-w-72 flex-1 rounded-lg border border-border-subtle bg-surface-elevated px-4 py-3 text-sm text-text-primary outline-none transition focus:border-accent-jin/70"
            value={input}
            onChange={(event) => onChangeInput(event.target.value)}
            placeholder="Message Director"
            autoComplete="off"
            data-no-drag
          />
          <button
            type="button"
            className={`rounded-lg border px-4 py-3 text-sm font-medium transition ${
              isMicOpen
                ? 'border-status-working/60 bg-status-working/20 text-status-working'
                : 'border-border-subtle bg-white/5 text-text-secondary hover:text-text-primary'
            }`}
            onClick={onToggleMic}
            data-no-drag
          >
            Mic
          </button>
          <button
            type="submit"
            className="rounded-lg border border-accent-jin/70 bg-accent-jin/20 px-4 py-3 text-sm font-semibold text-text-primary transition hover:bg-accent-jin/30 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={input.trim().length === 0}
            data-no-drag
          >
            Send
          </button>

          <div className="flex flex-wrap items-center gap-2 pl-2">
            <button
              type="button"
              className="rounded-lg border border-border-subtle bg-white/5 px-3 py-2 text-xs font-medium text-text-secondary transition hover:text-text-primary"
              onClick={() => startMixtapeDemo({ compressed: false })}
              data-no-drag
            >
              Start Mixtape Demo
            </button>
            <button
              type="button"
              className="rounded-lg border border-border-subtle bg-white/5 px-3 py-2 text-xs font-medium text-text-secondary transition hover:text-text-primary"
              onClick={() => resolveJinBlocker('mock the gateway')}
              data-no-drag
            >
              Resolve Jin
            </button>
            <button
              type="button"
              className="rounded-lg border border-border-subtle bg-white/5 px-3 py-2 text-xs font-medium text-text-secondary transition hover:text-text-primary"
              onClick={showMoodboardPreset}
              data-no-drag
            >
              Show Moodboard
            </button>
            <button
              type="button"
              className="rounded-lg border border-border-subtle bg-white/5 px-3 py-2 text-xs font-medium text-text-secondary transition hover:text-text-primary"
              onClick={showArtifactPreset}
              data-no-drag
            >
              Show Artifact
            </button>
          </div>
        </form>
      </footer>
    </div>
  );
}
