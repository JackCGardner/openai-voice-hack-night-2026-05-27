import type { JSX } from 'react';
import { ListeningStrip } from './ListeningStrip';

interface SpeakingStripProps {
  /** Remote audio MediaStream from the Realtime RTCPeerConnection. */
  audioStream?: MediaStream | null;
}

/**
 * Speaking Strip — Director output waveform.
 * Same geometry as ListeningStrip, mirrored vertically with coral tint
 * (--accent-maya) per Pass 4 anti-slop guidance: AI output reads coral,
 * user input reads green.
 */
export function SpeakingStrip({ audioStream }: SpeakingStripProps): JSX.Element {
  return (
    <ListeningStrip
      audioStream={audioStream}
      tint="maya"
      mirrored
      ariaLabel="Director speaking"
    />
  );
}
