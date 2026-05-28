# Mixtape

**Vibe-to-playlist card generator.** Speak a mood, get a curated 8-track card with cover art, runtime, and a one-click share link.

This package is **the demo target for Director** — a partially-built Next.js app that Director's parallel sub-agents (Maya, Jin, Cleo, Wren) "finish" live on stage during the 5-minute hackathon demo. See [`docs/research/demo-target-app.md`](../../docs/research/demo-target-app.md) for the full concept and timeline.

> Mixtape is intentionally a *vibe object* — no real audio, no Spotify auth, no streaming. The product surface is purely **aesthetic generation + interactive card UI + persistence of share links**. That's what makes it small enough for four agents to scaffold in parallel.

## Running

```bash
pnpm install            # from repo root, workspace is configured
pnpm --filter mixtape dev
```

Dev server: **http://localhost:3001**.

In the current state you can type a vibe, hit Generate, and get a list of 8 mock tracks rendered inline. The "real" playlist card (flip animation, cover art, hover-waveform tracks, share page) is intentionally left as TODOs — those are what Director's agents build during the demo.

## What's already done

| File | Notes |
|---|---|
| `app/page.tsx` | Mounts `VibeInput` |
| `app/layout.tsx`, `app/globals.css` | Tailwind v4 + dark surface tokens |
| `components/VibeInput.tsx` | Input + Generate button, posts to `/api/generate` |
| `app/api/generate/route.ts` | Returns a `Mixtape` with 8 mock tracks |
| `lib/schema.ts` | Canonical `Mixtape` / `Track` types |
| `lib/mockTracks.ts` | ~200-entry pool of fake-but-believable tracks, vibe-tag filtered |
| `lib/id.ts` | Short nanoid-style share id generator |
| `data/mixtapes.json` | Empty array, waiting for `lib/store` |

## What the demo will finish (TODOs)

Each placeholder file leads with a comment naming the agent who builds it. Identities and accent colors are from `docs/ux-design.md` Pass 4.

| Agent | Role | Accent | Files |
|---|---|---|---|
| **Maya** | Frontend (React + Tailwind, composition over inheritance) | coral | `app/m/[id]/page.tsx`, `components/PlaylistCard.tsx`, `components/CoverArt.tsx`, `components/TrackRow.tsx` |
| **Jin** | Backend (Next.js API routes, edge-friendly handlers) | slate blue | `app/api/mixtape/[id]/route.ts` |
| **Cleo** | Data (schemas-first, file-backed JSON for demo persistence) | ochre | `lib/store.ts` |
| **Wren** | Design (Tailwind tokens, motion primitives, theme tokens) | plum | `styles/themes.ts` |

Interface contracts are tiny on purpose: a `Mixtape` type shared via `lib/schema.ts` lets all four agents fan out without waiting on each other.

## Demo decision points (Canvas moments)

Director will pause three times during the build and route the answer back into the codebase:

1. **T+0:45 — Card material.** Matte vinyl vs transparent cassette vs holographic foil. Drives `styles/themes.ts` (Wren) and `PlaylistCard` material variant (Maya).
2. **T+2:15 — Cover art style.** Abstract gradient mesh vs pixel-art diorama. Drives `CoverArt.tsx` (Maya) and the cover-prompt template (Jin).
3. **T+3:30 — Share layout.** Full-bleed hero poster vs stacked card-plus-tracklist. Drives `app/m/[id]/page.tsx` (Maya).

## Demo blocker moments

1. **T+1:30 — No music data source.** Jin's ring goes amber. Director escalates by voice; user says "use mock tracks." Jin falls back to `lib/mockTracks.ts`. (Already wired — that fallback is the default in this scaffold.)
2. **T+4:00 — Persistence target ambiguous.** Cleo's ring goes amber. Director asks; user says "file store." Cleo finishes `lib/store.ts` against `data/mixtapes.json`.

## Stack

- Next.js 15 (App Router)
- React 19
- TypeScript
- Tailwind CSS v4 (CSS-config via `@theme`)
- Framer Motion (for the flip animation Maya wires)
