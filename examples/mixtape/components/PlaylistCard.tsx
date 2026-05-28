// TODO (Maya): flippable card with cover + tracklist, Framer Motion spring
//
// Director will dispatch Maya (Frontend) to build this during the demo.
// Expected behavior:
//   - Props: { mixtape: Mixtape }.
//   - Front face: CoverArt + vibe label + mixtape id.
//   - Back face: tracklist rendered via TrackRow.
//   - Flip on click using Framer Motion spring (--spring-default from design tokens).
//   - Theme controlled by mixtape.theme (matte | cassette | holographic) — Wren's tokens.

import type { Mixtape } from "@/lib/schema";

type Props = { mixtape: Mixtape };

export default function PlaylistCard(_props: Props) {
  return (
    <div className="rounded-xl border border-dashed border-white/20 p-6 text-sm text-[color:var(--color-text-dim)]">
      PlaylistCard placeholder — Maya wires the flip animation live.
    </div>
  );
}
