// TODO (Maya): hover-waveform track row
//
// Director will dispatch Maya (Frontend) to build this during the demo.
// Expected behavior:
//   - Props: { track: Track; index: number }.
//   - Row layout: index · title/artist · runtime.
//   - On hover, swap the runtime for a tiny animated waveform (CSS or SVG).
//   - Quiet by default — no glow, no badges. Matches the design system.

import type { Track } from "@/lib/schema";

type Props = { track: Track; index: number };

export default function TrackRow(_props: Props) {
  return null;
}
