/**
 * StripSurface — the canonical "product" surface mounted inside the slim
 * right-edge overlay window. Reads `store.strip.kind` and mounts the
 * matching Strip component. The window itself is transparent + vibrancy
 * (see `main/index.ts` createStripWindow), so this surface root is
 * background-less and lets each Strip component own its own pill.
 *
 * Per docs/vision.md (Anatomy of the Interface), this — not the chat —
 * is the product. The Chat surface is debug-only, behind the tray menu.
 */

import { type JSX } from 'react';
import { useStore } from '../state/store';
import { DormantStrip } from './DormantStrip';
import { ListeningStrip } from './ListeningStrip';
import { SpeakingStrip } from './SpeakingStrip';
import { ThinkingStrip } from './ThinkingStrip';
import { HiveStrip } from './HiveStrip';
import { Captions } from './Captions';
import type { StripStateKind } from '../../../shared/state';

export interface StripSurfaceProps {
  /** Live mic MediaStream from the renderer's RealtimeClient (W1). */
  micStream?: MediaStream | null;
  /** Remote audio MediaStream (Realtime output) for the speaking waveform. */
  remoteStream?: MediaStream | null;
}

export function StripSurface({
  micStream,
  remoteStream,
}: StripSurfaceProps): JSX.Element {
  const kind = useStore((s) => s.strip.kind);
  return (
    <>
      {renderStripFor(kind, micStream ?? null, remoteStream ?? null)}
      {/* § captions (W4 — P5.1) — sibling of Strip, anchored 24px below. */}
      <Captions />
    </>
  );
}

function renderStripFor(
  kind: StripStateKind,
  micStream: MediaStream | null,
  remoteStream: MediaStream | null,
): JSX.Element {
  switch (kind) {
    case 'dormant':
    case 'connecting':
    case 'disconnected':
    case 'error':
      return <DormantStrip />;
    case 'listening':
      return <ListeningStrip audioStream={micStream} />;
    case 'speaking':
      return <SpeakingStrip audioStream={remoteStream} />;
    case 'thinking':
      return <ThinkingStrip />;
    case 'hive':
    case 'escalating':
      return <HiveStrip />;
    default: {
      const _exhaust: never = kind;
      void _exhaust;
      return <DormantStrip />;
    }
  }
}
