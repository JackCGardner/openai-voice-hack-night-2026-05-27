import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import { useRealtimeClient } from './hooks/useRealtimeClient';
import { useStore } from './state/store';
import { ChatSurface, type ChatMessage } from './components/ChatSurface';
import { StripSurface } from './components/StripSurface';
import { devToolCall } from './lib/toolBridge';
import { PendingConsults, consultTicketIdFromAnnounce } from './realtime/pending-consults';
import type { StripStateKind } from '../../shared/state';
// ─── § W4 P5 polish hooks (append-only — docs/contracts.md § 13.2) ──────
// These hooks own all P5.1 + P5.3 side-effects so App.tsx stays a single
// orchestrator. Each is defensively-coded — missing bridges noop quietly.
import { useAssistantCaptionStream } from './hooks/useAssistantCaptionStream';
import { useStripDragHandle } from './hooks/useStripDragHandle';
import { useOnboarding } from './hooks/useOnboarding';
import { useAudioCuesMount } from './hooks/useAudioCuesMount';

const IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

// Strip overlay window dims per stripState — Pass 2 of docs/ux-design.md.
// Small variants stay 12×180 right-edge pills; live states (listening /
// speaking / thinking) grow to 38px; hive + escalating expand to 280×420.
const STRIP_DIMS: Record<StripStateKind, { width: number; height: number }> = {
  dormant: { width: 12, height: 180 },
  connecting: { width: 38, height: 180 },
  listening: { width: 38, height: 180 },
  speaking: { width: 38, height: 180 },
  thinking: { width: 38, height: 180 },
  hive: { width: 280, height: 420 },
  escalating: { width: 280, height: 420 },
  error: { width: 12, height: 180 },
  disconnected: { width: 12, height: 180 },
};

type Surface = 'strip' | 'chat';

function getSurface(): Surface {
  if (typeof window === 'undefined') return 'strip';
  const params = new URLSearchParams(window.location.search);
  return params.get('surface') === 'chat' ? 'chat' : 'strip';
}

function transcriptText(evt: Record<string, unknown>): string | null {
  const transcript = evt.transcript;
  if (typeof transcript !== 'string') return null;
  const text = transcript.trim();
  return text.length > 0 ? text : null;
}

export function App(): JSX.Element {
  const surface = getSurface();
  const { client, status: realtimeStatus, micStream, remoteStream } =
    useRealtimeClient();
  const stripKind = useStore((s) => s.strip.kind);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [micMode, setMicMode] = useState(client.micMode);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // ─── § consult-hold (idle-teardown safety valve — demo-critical) ─────────
  // Tracks in-flight async `consult_director` calls so we can hold the
  // Realtime peer open while the deep brain (gpt-5.5, full shell) thinks. The
  // 45s idle-teardown would otherwise close the peer mid-think once the user
  // goes quiet, and the answer announce would be dropped (the bug). The
  // tracker's hold/release edges drive `client.holdPeer()`; we add on the
  // `thinking` ack and resolve when the matching announce lands. Stable across
  // renders (the client is stable from useRealtimeClient).
  const pendingConsultsRef = useRef<PendingConsults | null>(null);
  if (pendingConsultsRef.current === null) {
    pendingConsultsRef.current = new PendingConsults((hold) => client.holdPeer(hold));
  }
  const pendingConsults = pendingConsultsRef.current;

  // ─── § W4 P5 polish wiring (append-only) ────────────────────────────────
  // Captions stream (P5.1), Strip-as-Canvas-handle (P5.3), onboarding form
  // (P5.3), and the audio cues mount (P5.2 — owned by W3 but mounted here
  // per the App.tsx hook convention in docs/contracts.md § 13.2). All four
  // hooks are no-ops on the `chat` debug surface; they activate when the
  // strip overlay window mounts.
  useAssistantCaptionStream(client);
  useStripDragHandle();
  useOnboarding(client);
  useAudioCuesMount();
  // ─────────────────────────────────────────────────────────────────────────

  // Log Realtime lifecycle. W3 reflects this into store.setRealtimeStatus later.
  useEffect(() => {
    console.log(`[realtime] status → ${realtimeStatus}`);
  }, [realtimeStatus]);

  // ── Connect-on-demand (cost control) ───────────────────────────────────
  // We deliberately do NOT auto-connect on launch. The OpenAI Realtime API
  // bills per minute the session is open, so holding a live peer while the
  // user is idle burns money for nothing. Instead the app launches dormant
  // (no token, no mic, no peer) and connects on the first push-to-talk
  // gesture (see the PTT handlers below). The client also tears the peer
  // down after an idle window — see RealtimeClient idle-teardown.
  //
  // (Was: auto-connect on strip mount. Removed per cost requirement —
  // "assume on launch that the user isn't going to be immediately using it".)

  // ─── § renderer-wireup (gaps 1/2/10/11) — degradation + rotation UX ──────
  // Gated to the strip surface so the chat-debug window never drives Canvas
  // cards or rotation. Wires the client's UX hooks (mic-denied / persistent-
  // degraded / rotation-failed) to the Canvas window + main-process effects,
  // arms the T+55 rotation timer once connected, and surfaces api_key_missing
  // on a token-mint 401.
  useEffect(() => {
    if (surface !== 'strip') return;
    const bridge = window.director;

    const openCard = (
      component: string,
      props: Record<string, unknown> = {},
      componentId?: string,
    ): void => {
      // Drive the real Canvas window (the strip store's openCanvas is local
      // only). Best-effort — bridge is absent outside Electron.
      bridge?.canvas?.render({
        component,
        props,
        component_id: componentId ?? `${component}-${Date.now()}`,
      });
    };

    // Speak a short apology through the live peer (best-effort; no-op if the
    // data channel isn't open). Mirrors the escalation injection pattern.
    const speakApology = (text: string): void => {
      if (client.status !== 'connected' || !client.dcReady) return;
      client.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: `Say exactly: "${text}" Be terse.` }],
        },
      });
      client.send({ type: 'response.create' });
    };

    client.setUxHooks({
      // gap 10 — mic permission denied.
      onMicDenied: () => {
        openCard('mic_denied', {}, 'degrade-mic-denied');
        speakApology("I can't hear you. Mic permission needed.");
      },
      // gap 2 — persistent degraded after retries: notification + tray dot
      // (via main) + degraded/rotation Canvas card with a text-fallback hint.
      onPersistentDegraded: (info) => {
        bridge?.app?.notifyDegraded({
          outageMs: info.outageMs,
          attempt: info.attempt,
        });
        openCard(
          'rotation_failed',
          { message: 'Director is offline — reconnecting. You can type instead.' },
          'degrade-offline-persistent',
        );
      },
      // gap (P6.6) — rotation failed 3×: soft rotation_failed card.
      onRotationFailed: () => {
        openCard(
          'rotation_failed',
          { message: 'Session will reset in ~1s — sorry for the blip.' },
          'degrade-rotation-failed',
        );
      },
    });

    // gap 11 — token mint failed. 401 (or missing key) → api_key_missing card.
    const offMintError = bridge?.realtimeErrors?.onMintError((payload) => {
      if (payload.status === 401) {
        openCard('api_key_missing', {}, 'degrade-api-key-missing');
        speakApology('OpenAI key needed.');
      } else {
        console.warn('[realtime] mint error (non-auth)', payload);
      }
    });

    return () => {
      offMintError?.();
    };
  }, [client, surface]);

  // gap 1 — arm the T+55 rotation timer once the strip session connects.
  useEffect(() => {
    if (surface !== 'strip') return;
    if (realtimeStatus !== 'connected') return;
    client.enableRotationTimer();
  }, [client, surface, realtimeStatus]);

  // Keep the newest transcript turn pinned in view.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages]);

  // Bridge global hotkey from main process (W1).
  // GATED to strip surface only — the global hotkey fires IPC to BOTH windows
  // (strip + chat-debug). Without this gate, both would react and we'd double-
  // grab the mic + double-fire Realtime responses.
  useEffect(() => {
    if (surface !== 'strip') return;
    const bridge = window.director;
    if (!bridge) return;
    return bridge.onHotkey(() => {
      // Touch the canonical store: hotkey while dormant = summon.
      const s = useStore.getState();
      if (s.strip.kind === 'dormant' || s.strip.kind === 'hive') {
        s.summon('tap');
      }
      // W1.hotkey: tap-toggle. Electron globalShortcut can't observe
      // key-up for chord keys, so the spec's hold/release is not wired
      // — kept as a TODO behind a native key listener.
      // Cold press → connect (mic defaults to tap-open).
      // Warm press → toggle mic without dropping the peer.
      if (client.status === 'idle' || client.status === 'closed' || client.status === 'error') {
        client.connect().catch((err) => {
          console.error('[realtime] connect failed', err);
        });
      } else if (client.status === 'connected') {
        const next = client.toggleMicTap();
        console.log(`[realtime] mic → ${next}`);
      }
    });
  }, [client, surface]);

  // ── Push-to-talk (native ⌃⌥ listener relayed from main) ────────────────
  // Wispr-Flow model: HOLD ⌃⌥ to talk (connect-on-demand + hold-open mic),
  // release to send (mute → idle teardown stops billing). DOUBLE-TAP to lock
  // hands-free (mic stays open until toggled off). GATED to strip surface.
  // connect() is async (~1–2s); we reconcile to the LATEST intent once the
  // peer is live, so a quick hold released mid-connect ends up muted, not hot.
  useEffect(() => {
    if (surface !== 'strip') return;
    const bridge = window.director;
    if (!bridge?.ptt) return;
    let pttHeld = false;
    const settleTimers = new Set<ReturnType<typeof setInterval>>();

    const summonIfDormant = (): void => {
      const s = useStore.getState();
      if (s.strip.kind === 'dormant' || s.strip.kind === 'hive') s.summon('tap');
    };
    // Run `cb` once the peer is connected — now if already live, else connect
    // on demand and poll until the data channel is up (bounded ~8s).
    const whenConnected = (cb: () => void): void => {
      if (client.status === 'connected') {
        cb();
        return;
      }
      if (client.status === 'idle' || client.status === 'closed' || client.status === 'error') {
        client.connect().catch((err) => console.error('[realtime] PTT connect failed', err));
      }
      const t = setInterval(() => {
        if (client.status === 'connected') {
          clearInterval(t);
          settleTimers.delete(t);
          cb();
        } else if (client.status === 'idle' || client.status === 'error') {
          clearInterval(t);
          settleTimers.delete(t);
        }
      }, 100);
      settleTimers.add(t);
      setTimeout(() => {
        clearInterval(t);
        settleTimers.delete(t);
      }, 8000);
    };

    const offDown = bridge.ptt.onDown(() => {
      pttHeld = true;
      summonIfDormant();
      // Reconcile to the held state at the moment we're actually live.
      whenConnected(() => client.setMicMode(pttHeld ? 'hold-open' : 'muted'));
    });

    const offUp = bridge.ptt.onUp(() => {
      pttHeld = false;
      if (client.status === 'connected') client.setMicMode('muted');
      // If still mid-connect, the whenConnected callback above sees pttHeld
      // === false and lands on muted — no hot mic after a released hold.
    });

    const offLock = bridge.ptt.onLock(() => {
      summonIfDormant();
      // Capture intent now: off (muted/disconnected) → turn ON; on → turn OFF.
      const wantOn = client.status !== 'connected' || client.micMode === 'muted';
      whenConnected(() => client.setMicMode(wantOn ? 'tap-open' : 'muted'));
    });

    return () => {
      offDown();
      offUp();
      offLock();
      settleTimers.forEach((t) => clearInterval(t));
      settleTimers.clear();
    };
  }, [client, surface]);

  // ── Drive stripState from real Realtime events ─────────────────────────
  //
  //  - mic mode flips to tap-open / hold-open → setListening
  //  - response audio deltas → setSpeaking
  //  - response.done → drift back to listening (if mic still open) or rest
  //
  //  The transitions are guarded by the canonical store's allowed-from
  //  sets in store.ts §setListening / §setSpeaking, so a misfire just logs.
  useEffect(() => {
    const offMicMode = client.on('micMode', (mode) => {
      setMicMode(mode);
      const s = useStore.getState();
      if (mode === 'tap-open' || mode === 'hold-open') {
        if (
          s.strip.kind === 'dormant' ||
          s.strip.kind === 'speaking' ||
          s.strip.kind === 'hive' ||
          s.strip.kind === 'thinking'
        ) {
          s.setListening(mode === 'hold-open' ? 'hold' : 'tap');
        }
      } else if (mode === 'muted' && s.strip.kind === 'listening') {
        s.mute();
      }
    });

    let currentItemId: string | null = null;
    const offEvent = client.on('event', (evt) => {
      const type = evt.type as string | undefined;
      if (!type) return;

      if (type === 'conversation.item.input_audio_transcription.completed') {
        const text = transcriptText(evt);
        if (text) {
          setMessages((current) => [...current, { role: 'user', text }]);
        }
      }

      if (type === 'response.output_audio_transcript.done') {
        const text = transcriptText(evt);
        if (text) {
          setMessages((current) => [...current, { role: 'assistant', text }]);
        }
      }

      // First sign of model audio output → transition to speaking.
      if (
        type === 'response.output_audio.delta' ||
        type === 'response.audio.delta' ||
        type === 'response.output_audio_transcript.delta'
      ) {
        const itemId = (evt.item_id as string | undefined) ?? currentItemId ?? 'response';
        currentItemId = itemId;
        const s = useStore.getState();
        if (
          s.strip.kind === 'listening' ||
          s.strip.kind === 'thinking' ||
          s.strip.kind === 'hive' ||
          s.strip.kind === 'dormant'
        ) {
          s.setSpeaking(itemId, 'commentary');
        }
      }

      // Response finished → if the mic is still open the user can speak
      // immediately; otherwise drift toward hive (if work) or dormant.
      if (type === 'response.done') {
        currentItemId = null;
        const s = useStore.getState();
        if (s.strip.kind === 'speaking') {
          if (client.micMode === 'tap-open' || client.micMode === 'hold-open') {
            s.setListening(client.micMode === 'hold-open' ? 'hold' : 'tap');
          } else {
            s.mute();
          }
        }
      }
    });

    return () => {
      offMicMode();
      offEvent();
    };
  }, [client]);

  // (Removed: the sim's `director:escalation` CustomEvent bridge. Real
  // escalations — e.g. the Codex hang watchdog — now arrive via
  // IpcChannel.ToolProactiveAnnounce and are injected by the proactive-announce
  // consumer below. No window-event demo path.)

  // ─── § consult-hold — register in-flight consults ───────────────────────
  // When `consult_director` returns its `{ status:'thinking', ticketId }` ack
  // (surfaced by client.dispatchTool), add it to the tracker. The tracker's
  // hold edge calls client.holdPeer(true), suppressing idle-teardown until the
  // matching announce resolves it below. Gated to the strip surface — the
  // chat-debug window must never drive the live peer's teardown clock.
  useEffect(() => {
    if (surface !== 'strip') return;
    const off = client.on('consultThinking', ({ ticketId }) => {
      console.log('[consult-hold] thinking — holding peer for', ticketId);
      pendingConsults.add(ticketId);
    });
    return () => {
      off();
      // Unmount / client swap: drop holds so we never pin a peer open via a
      // tracker that's about to be orphaned. (Strip surface is long-lived, so
      // this is belt-and-braces.)
      pendingConsults.clear();
    };
  }, [client, surface, pendingConsults]);

  // ─── § proactive-announce (Integrate wave — spec §1.7) ──────────────────
  // Subscribe to main-pushed proactive announcements (IpcChannel.
  // ToolProactiveAnnounce, via window.director.proactive.onAnnounce). This is
  // the foreground consumer the spec flagged as the missing GAP: it lights up
  // BOTH the async consult_director result ("On <topic>: …") AND the existing
  // hang watchdog ("Maya seems stuck…"). We inject p.text as unprompted
  // assistant speech using the proven escalation injector pattern above.
  //
  // p.text is already fully formed by the engine (the "On <topic>: " prefix is
  // applied in consult-tickets.ts) — we do NOT re-wrap it. v1: if the peer was
  // torn down (idle-teardown) we log + drop; the user can re-ask.
  useEffect(() => {
    if (surface !== 'strip') return; // never inject from the chat-debug window
    const bridge = window.director;
    if (!bridge?.proactive?.onAnnounce) {
      console.warn('[proactive] bridge.proactive.onAnnounce not exposed — announcements dropped');
      return;
    }
    // Speak the announce ONCE via per-response instructions. We deliberately do
    // NOT add a persistent `conversation.item.create` (role:system "say this
    // verbatim") — that lingers in the conversation and the model re-says it on
    // every later turn, which feels un-interruptible. Per-response instructions
    // affect only this one response and are never added to history, so it
    // speaks once and the user can move the conversation on. Barge-in still
    // cancels it normally.
    const speakOnce = (text: string): boolean =>
      client.send({
        type: 'response.create',
        response: {
          instructions: `Say this to the user now, conversationally and briefly, then stop — do not add anything else: ${text}`,
        },
      });

    const off = bridge.proactive.onAnnounce((p) => {
      console.log('[proactive] announce', p);

      // ─── § consult-hold — release the in-flight consult ─────────────────
      // The answer (or error) for an async consult arrived: drop its ticket so
      // the peer hold lifts (idle-teardown resumes once no consults remain).
      // Non-consult announces (e.g. the hang watchdog) carry no consult
      // ticketId and resolve() no-ops on them.
      const ticketId = consultTicketIdFromAnnounce(p);
      if (ticketId) pendingConsults.resolve(ticketId);

      // Fast path: peer is live → speak immediately.
      if (client.status === 'connected' && client.dcReady) {
        speakOnce(p.text);
        return;
      }

      // ─── § announce-backstop (demo-critical) ────────────────────────────
      // The peer was torn down (idle-teardown raced the slow brain) before the
      // answer landed. Rather than DROP the answer, reconnect then speak it, so
      // even a teardown race still delivers. connect() re-mints + reopens the
      // peer (~1–2s); we then inject the one-shot speak. Best-effort: if the
      // reconnect or send fails we log — we never throw out of the IPC callback.
      console.warn('[proactive] peer gone — reconnecting to deliver', p);
      void (async () => {
        try {
          if (client.status === 'idle' || client.status === 'closed' || client.status === 'error') {
            await client.connect();
            // This is an UNPROMPTED delivery — the user didn't open the mic.
            // connect() defaults the mic to tap-open; mute it so we don't
            // capture ambient audio and so idle-teardown re-arms after the
            // answer plays (cost control). The user can re-open via PTT.
            client.setMicMode('muted');
          }
          // Poll briefly for the data channel to open (connect resolves once the
          // peer is connected, but the DC can lag a beat). Bounded ~5s.
          const deadline = Date.now() + 5_000;
          while (!(client.status === 'connected' && client.dcReady) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
          }
          if (client.status === 'connected' && client.dcReady) {
            if (!speakOnce(p.text)) {
              console.warn('[proactive] reconnected but speak send dropped', p);
            } else {
              console.log('[proactive] delivered after reconnect');
            }
          } else {
            console.warn('[proactive] reconnect did not reach a live DC — answer dropped', p);
          }
        } catch (err) {
          console.error('[proactive] reconnect-to-deliver failed', err);
        }
      })();
    });
    return off;
  }, [client, surface, pendingConsults]);

  // Strip auto-resize per state. Only the Strip overlay window cares about
  // resizeStrip — the Chat debug window has a normal frame and keeps its
  // fixed size. Dims live in STRIP_DIMS per Pass 2 of docs/ux-design.md.
  useEffect(() => {
    if (surface !== 'strip') return;
    const bridge = window.director;
    if (!bridge?.window?.resizeStrip) return;
    const dims = STRIP_DIMS[stripKind];
    bridge.window.resizeStrip(dims).catch((err) => {
      console.warn('[strip] resize failed', err);
    });
  }, [surface, stripKind]);

  // Dev switcher — only in development. 1-7 cycle strip states for visual
  // inspection; T fires a real dispatch smoke; H fires an update_harness
  // smoke. Real interactions (hotkey + Realtime events) drive the strip in
  // production.
  useEffect(() => {
    if (!IS_DEV) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Don't hijack typing inside text inputs (only the chat debug
      // window has one, but be defensive).
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      const map: Record<string, () => void> = {
        '1': () => useStore.setState({ strip: { kind: 'dormant' } }),
        '2': () =>
          useStore.setState({
            strip: { kind: 'listening', mode: 'tap', since: Date.now() },
          }),
        '3': () =>
          useStore.setState({
            strip: {
              kind: 'speaking',
              itemId: 'dev-speak',
              phase: 'commentary',
              since: Date.now(),
            },
          }),
        '4': () =>
          useStore.setState({
            strip: { kind: 'thinking', trail: [], since: Date.now() },
          }),
        '5': () =>
          useStore.setState({
            strip: { kind: 'hive', activeAgentId: null, since: Date.now() },
          }),
        '6': () =>
          useStore.setState({
            strip: {
              kind: 'escalating',
              agentId: 'jin',
              blocker: 'demo',
              since: Date.now(),
            },
          }),
        '7': () =>
          useStore.setState({
            strip: { kind: 'hive', activeAgentId: null, since: Date.now() },
          }),
        t: () =>
          void devToolCall('dispatch_agent_mock', {
            agent: 'maya',
            task: 'dev smoke: build a hello-world component',
          }),
        T: () =>
          void devToolCall('dispatch_agent_mock', {
            agent: 'maya',
            task: 'dev smoke: build a hello-world component',
          }),
        h: () =>
          void devToolCall('update_harness', {
            rule: 'No gradients ever',
            why: 'User said so',
          }),
        H: () =>
          void devToolCall('update_harness', {
            rule: 'No gradients ever',
            why: 'User said so',
          }),
      };
      const fn = map[e.key];
      if (fn) {
        fn();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sendText = (): void => {
    const text = input.trim();
    if (!text) return;

    setMessages((current) => [...current, { role: 'user', text }]);
    setInput('');

    const okItem = client.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    const okResp = client.send({ type: 'response.create' });

    if (!okItem || !okResp) {
      console.warn(
        `[realtime] text send skipped because data channel is not open (status=${client.status})`,
      );
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    sendText();
  };

  const toggleMic = (): void => {
    if (client.status === 'idle' || client.status === 'closed' || client.status === 'error') {
      client.connect().catch((err) => {
        console.error('[realtime] connect failed', err);
      });
      return;
    }

    if (client.status === 'connected') {
      const next = client.toggleMicTap();
      setMicMode(next);
      console.log(`[realtime] mic → ${next}`);
    }
  };

  if (surface === 'chat') {
    return (
      <ChatSurface
        realtimeStatus={realtimeStatus}
        micMode={micMode}
        onToggleMic={toggleMic}
        messages={messages}
        messagesEndRef={messagesEndRef}
        input={input}
        onChangeInput={setInput}
        onSubmit={onSubmit}
      />
    );
  }
  return <StripSurface micStream={micStream} remoteStream={remoteStream} />;
}
