// TODO (Wren): theme tokens for matte / cassette / holographic card materials
//
// Director will dispatch Wren (Design) to build this during the demo.
// Expected behavior:
//   - Export a `themes` record keyed by MixtapeTheme.
//   - Each entry: surface, accent, border, shadow, foilGradient (optional),
//     plus motion overrides if the material needs different easing.
//   - Consumers: PlaylistCard, CoverArt, TrackRow.
//   - Tokens follow docs/ux-design.md Pass 5 colour rules (≤70% saturation,
//     calm vs neon, hairline borders, soft shadows).

import type { MixtapeTheme } from "@/lib/schema";

export type ThemeTokens = {
  surface: string;
  accent: string;
  border: string;
  shadow: string;
};

export const themes: Record<MixtapeTheme, ThemeTokens> = {
  matte: { surface: "", accent: "", border: "", shadow: "" },
  cassette: { surface: "", accent: "", border: "", shadow: "" },
  holographic: { surface: "", accent: "", border: "", shadow: "" },
};
