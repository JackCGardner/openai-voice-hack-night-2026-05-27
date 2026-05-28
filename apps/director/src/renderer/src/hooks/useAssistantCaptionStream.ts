/**
 * useAssistantCaptionStream — feeds the global Captions buffer with words
 * from Director's assistant transcript stream as they arrive on the
 * RealtimeClient `event` channel.
 *
 * Listens to:
 *   - `response.output_audio_transcript.delta`   — streaming words
 *   - `response.output_audio_transcript.done`    — close-out (no-op; we keep
 *                                                  the trailing fade)
 *
 * Mounted via the W4 hook convention (docs/contracts.md § 13.2) from
 * App.tsx. Defensive: tolerates missing fields and bad payloads — every
 * malformed event becomes a console.warn + noop.
 *
 * Spec: docs/remaining-phases.md § 5.1.
 */

import { useEffect } from 'react';
import type { RealtimeClient } from '../realtime/client.js';
import { appendCaptionDelta } from '../state/captionBuffer.js';

const TRANSCRIPT_DELTA_TYPES = new Set<string>([
  'response.output_audio_transcript.delta',
  // Some Realtime SDK variants emit a plain text delta too — accept both.
  'response.audio_transcript.delta',
]);

export function useAssistantCaptionStream(client: RealtimeClient): void {
  useEffect(() => {
    if (!client) return;
    const off = client.on('event', (evt) => {
      try {
        const type = (evt as { type?: unknown }).type;
        if (typeof type !== 'string') return;
        if (!TRANSCRIPT_DELTA_TYPES.has(type)) return;
        const delta = (evt as { delta?: unknown }).delta;
        const responseId =
          (evt as { response_id?: unknown }).response_id ??
          (evt as { item_id?: unknown }).item_id;
        appendCaptionDelta(delta, responseId);
      } catch (err) {
        // Defensive guard — Captions must never crash the realtime pipe.
        // eslint-disable-next-line no-console
        console.warn('[useAssistantCaptionStream] event handler threw', err);
      }
    });
    return off;
  }, [client]);
}
