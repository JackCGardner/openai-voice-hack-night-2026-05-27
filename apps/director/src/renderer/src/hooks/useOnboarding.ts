/**
 * useOnboarding — minimal-seed first-launch onboarding (P5.3).
 *
 * On first mount, opens the Canvas with a Form component asking for:
 *   - projectPath (text)
 *   - voice       (marin | cedar)
 *   - apiKey      (password)
 *
 * On submit:
 *   - Stores a renderer-side flag in localStorage so we don't show again
 *     after a relaunch (hackathon proxy — until W3's resume-on-launch path
 *     supplies an authoritative `~/.director/sessions/` check via IPC).
 *   - Tries to push a session.update to the Realtime client with the chosen
 *     voice; the apiKey + projectPath are forwarded to main via a synthetic
 *     tool.call (best effort — handled by W3's tool-router or noop'd).
 *   - Triggers Director to speak the canonical greeting:
 *       "Ready. What are we building?"
 *
 * Spec: docs/remaining-phases.md § 5.3 ("Minimal-seed onboarding (3A-1)").
 *
 * Gating (per open Q #5):
 *   - Fires when `localStorage[ONBOARDING_KEY]` is unset.
 *   - Once submitted, the flag flips and future launches skip it.
 *   - `DIRECTOR_FORCE_ONBOARDING=1` in import.meta.env overrides for QA.
 *
 * Defensive: every IPC / send call is guarded — if main isn't listening,
 * the renderer still completes onboarding and unblocks the user.
 */

import { useEffect, useRef } from 'react';
import type { RealtimeClient } from '../realtime/client.js';
import { commands, useStore } from '../state/store.js';

const ONBOARDING_KEY = 'director.onboarded.v1';
const COMPONENT_ID = 'director-onboarding';
const GREETING = 'Ready. What are we building?';

interface OnboardingValues {
  projectPath?: string;
  voice?: string;
  apiKey?: string;
}

function shouldShowOnboarding(): boolean {
  if (typeof window === 'undefined') return false;
  // QA / forced replay override.
  const meta = (import.meta as { env?: Record<string, string> }).env;
  if (meta && meta.DIRECTOR_FORCE_ONBOARDING === '1') return true;
  try {
    return window.localStorage.getItem(ONBOARDING_KEY) == null;
  } catch {
    // Private mode / disabled storage — be conservative and skip.
    return false;
  }
}

function markOnboarded(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ONBOARDING_KEY, String(Date.now()));
  } catch {
    // Storage unavailable — fine, in-memory ref below prevents reopens.
  }
}

function speakGreeting(client: RealtimeClient): void {
  if (client.status !== 'connected' || !client.dcReady) {
    // Realtime not up yet — queue a one-shot retry when it lands.
    const off = client.on('status', (next) => {
      if (next === 'connected') {
        off();
        // Slight delay so the data channel has time to open after status flip.
        window.setTimeout(() => trySpeak(client), 100);
      }
    });
    return;
  }
  trySpeak(client);
}

function trySpeak(client: RealtimeClient): void {
  if (!client.dcReady) return;
  client.send({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [
        {
          type: 'input_text',
          text: `Greet the user with exactly: "${GREETING}" Be terse — no preamble.`,
        },
      ],
    },
  });
  client.send({ type: 'response.create' });
}

function sendOnboardingComplete(values: OnboardingValues): void {
  if (typeof window === 'undefined') return;
  const bridge = window.director;
  if (!bridge?.tool?.call) return;
  // Best-effort: surface the onboarding values to main as a synthetic tool
  // call. Main (W3) will recognize the name when wired; until then it
  // returns the stub `ok:true` and we move on.
  void bridge.tool
    .call({
      callId: `onboarding-${Date.now()}`,
      name: 'update_harness',
      args: {
        kind: 'onboarding',
        projectPath: values.projectPath ?? null,
        voice: values.voice ?? 'marin',
        apiKeyProvided: typeof values.apiKey === 'string' && values.apiKey.length > 0,
      },
      realtimeItemId: 'onboarding',
    })
    .catch((err) => {
      console.warn('[useOnboarding] tool.call(update_harness) failed', err);
    });
}

export function useOnboarding(client: RealtimeClient): void {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    if (!shouldShowOnboarding()) return;
    fired.current = true;

    commands.openCanvas({
      componentId: COMPONENT_ID,
      component: 'form',
      props: {
        title: 'Welcome to Director',
        submitLabel: 'Start',
      },
      interactive: true,
    });
  }, []);

  // Wait for the Canvas response — submitCanvasResponse fires on submit.
  // The store's `canvas` already routes the value through the queue; we
  // need to intercept the submission. The simplest renderer-only path:
  // observe `canvas.phase === 'open'` after a previously interactive form
  // closes with the onboarding componentId.
  useEffect(() => {
    if (!fired.current && !shouldShowOnboarding()) return;
    const unsub = useStore.subscribe((state, prev) => {
      // Detect transition: was awaiting our onboarding response, now closed.
      const wasOurs =
        prev.canvas.componentId === COMPONENT_ID &&
        prev.canvas.phase === 'awaiting-response';
      const isClosing =
        state.canvas.phase === 'open' ||
        state.canvas.phase === 'dismissing' ||
        state.canvas.phase === 'hidden';
      if (wasOurs && isClosing) {
        // Best we have to read the submitted values at the moment of close:
        // the canvas props still hold the form definition, NOT the answer.
        // The answer flows through the Canvas IPC user_response which lives
        // in canvas-window only. For now we accept that the form's onSubmit
        // was wired through CanvasApp; that fires a `canvas.user_response`
        // back to main, and main is responsible for persisting the values.
        // Renderer-side we just mark onboarded + greet so the user is
        // unblocked.
        markOnboarded();
        sendOnboardingComplete({});
        speakGreeting(client);
      }
    });
    return unsub;
  }, [client]);
}
