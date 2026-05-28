/**
 * Renderer-side Realtime client (WebRTC).
 *
 * Responsibilities:
 *  - Pull a fresh ephemeral token via the preload bridge (main process holds
 *    the real OPENAI_API_KEY; renderer never sees it).
 *  - Open an RTCPeerConnection with a mic track + the canonical "oai-events"
 *    data channel.
 *  - Exchange SDP with OpenAI's Realtime endpoint.
 *  - Surface a thin event-emitter API so higher layers (W3 state, W4 UI) can
 *    react to lifecycle + data-channel messages without touching WebRTC.
 *
 * This file does NOT wire tool dispatch, barge-in, or session.update — those
 * land in subsequent W1 commits (W1.session, W1.tools, W1.barge).
 *
 * Refs: docs/research/gpt-realtime-2.md §6 (transports + endpoints).
 */

import type { RealtimeEphemeralToken } from '../../../shared/realtime.js';

const SDP_URL = 'https://api.openai.com/v1/realtime/calls';

export type RealtimeClientStatus =
  | 'idle'
  | 'minting'
  | 'getting-mic'
  | 'connecting'
  | 'connected'
  | 'closed'
  | 'error';

export interface RealtimeClientEvents {
  status: RealtimeClientStatus;
  event: Record<string, unknown>; // any JSON event off oai-events
  error: Error;
}

type Listener<T> = (payload: T) => void;

export class RealtimeClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private micStream: MediaStream | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private listeners: { [K in keyof RealtimeClientEvents]: Set<Listener<unknown>> } = {
    status: new Set(),
    event: new Set(),
    error: new Set(),
  };
  private _status: RealtimeClientStatus = 'idle';

  get status(): RealtimeClientStatus {
    return this._status;
  }

  on<K extends keyof RealtimeClientEvents>(
    name: K,
    cb: Listener<RealtimeClientEvents[K]>,
  ): () => void {
    this.listeners[name].add(cb as Listener<unknown>);
    return () => this.listeners[name].delete(cb as Listener<unknown>);
  }

  private emit<K extends keyof RealtimeClientEvents>(
    name: K,
    payload: RealtimeClientEvents[K],
  ): void {
    for (const cb of this.listeners[name]) {
      try {
        (cb as Listener<RealtimeClientEvents[K]>)(payload);
      } catch (err) {
        // Never let a listener crash the client.
        console.error('[realtime] listener threw', err);
      }
    }
  }

  private setStatus(next: RealtimeClientStatus): void {
    if (this._status === next) return;
    this._status = next;
    this.emit('status', next);
  }

  /**
   * Connect end-to-end. Idempotent in error states: call close() first if
   * you want a clean retry.
   */
  async connect(token?: RealtimeEphemeralToken): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      throw new Error(`[realtime] cannot connect from status=${this._status}`);
    }

    try {
      // 1. Mint token (unless caller pre-minted).
      this.setStatus('minting');
      const bridge = window.director;
      if (!bridge) throw new Error('window.director bridge missing (non-Electron context?)');
      const realtimeToken = token ?? (await bridge.realtime.mintToken({}));

      // 2. Mic capture.
      this.setStatus('getting-mic');
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // 3. PeerConnection.
      this.setStatus('connecting');
      const pc = new RTCPeerConnection();
      this.pc = pc;

      // Remote audio: OpenAI sends model audio back as a track. Wire it
      // into a hidden <audio> element so it actually plays.
      pc.ontrack = (evt) => {
        if (!this.remoteAudio) {
          const el = document.createElement('audio');
          el.autoplay = true;
          el.style.display = 'none';
          document.body.appendChild(el);
          this.remoteAudio = el;
        }
        this.remoteAudio.srcObject = evt.streams[0] ?? new MediaStream([evt.track]);
      };

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') this.setStatus('connected');
        else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
          // Only downgrade if we were live; ignore transient "closed" before connect.
          if (this._status === 'connected') this.setStatus('closed');
        }
      };

      // Add mic track(s).
      for (const track of this.micStream.getAudioTracks()) {
        pc.addTrack(track, this.micStream);
      }

      // Data channel (canonical name).
      const dc = pc.createDataChannel('oai-events');
      this.dc = dc;
      dc.onopen = () => {
        // connectionState may flip after the DC opens — promote here too.
        if (pc.connectionState === 'connected') this.setStatus('connected');
      };
      dc.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(evt.data) as Record<string, unknown>;
          this.emit('event', parsed);
        } catch (err) {
          console.warn('[realtime] non-JSON event', err, evt.data);
        }
      };
      dc.onerror = (evt) => {
        const err = (evt as RTCErrorEvent).error ?? new Error('data channel error');
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      };

      // 4. SDP offer → POST → answer.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!offer.sdp) throw new Error('createOffer produced no SDP');

      const sdpRes = await fetch(SDP_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${realtimeToken.value}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
      });

      if (!sdpRes.ok) {
        const text = await sdpRes.text().catch(() => '<no body>');
        throw new Error(`[realtime] SDP exchange failed: HTTP ${sdpRes.status} — ${text}`);
      }

      const answerSdp = await sdpRes.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      // connectionState transition is async — onconnectionstatechange will
      // promote us to 'connected'. If it already happened, no-op.
    } catch (err) {
      this.setStatus('error');
      const e = err instanceof Error ? err : new Error(String(err));
      this.emit('error', e);
      this.close();
      throw e;
    }
  }

  /**
   * Toggle the mic on/off without tearing down the peer. Used by W1.hotkey.
   */
  setMicEnabled(enabled: boolean): void {
    if (!this.micStream) return;
    for (const track of this.micStream.getAudioTracks()) {
      track.enabled = enabled;
    }
  }

  /**
   * Send a JSON event over the data channel. No-op if the channel isn't open
   * yet — caller should gate on status === 'connected'.
   */
  send(event: Record<string, unknown>): boolean {
    if (!this.dc || this.dc.readyState !== 'open') return false;
    this.dc.send(JSON.stringify(event));
    return true;
  }

  close(): void {
    try {
      this.dc?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
    }
    if (this.remoteAudio && this.remoteAudio.parentNode) {
      this.remoteAudio.parentNode.removeChild(this.remoteAudio);
    }
    this.dc = null;
    this.pc = null;
    this.micStream = null;
    this.remoteAudio = null;
    this.setStatus('closed');
  }
}
