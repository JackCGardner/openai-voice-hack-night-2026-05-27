// TODO (Maya): SVG/CSS animated cover, takes vibe string
//
// Director will dispatch Maya (Frontend) to build this during the demo.
// Expected behavior:
//   - Props: { vibe: string; theme?: MixtapeTheme }.
//   - Generate a deterministic-but-aesthetic cover from the vibe text
//     (hash vibe -> palette + shapes; no external image deps).
//   - Animate subtly (drift / shimmer) using CSS or Framer Motion.
//   - Honor the Canvas-time decision on cover style
//     (abstract gradient mesh vs pixel-art diorama).

type Props = { vibe: string };

export default function CoverArt(_props: Props) {
  return (
    <div className="aspect-square w-full rounded-lg border border-dashed border-white/20" />
  );
}
