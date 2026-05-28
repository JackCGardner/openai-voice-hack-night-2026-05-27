## Title

Director — an ambient voice orchestration layer for attended parallelization

## One-liner

Speak intent; Director fans work to agents, interrupts only for judgment, and turns corrections into rules.

## Problem

Typing a prompt, waiting for a stream, reading the output, and re-prompting is the wrong shape for AI coding: it keeps the human trapped as a synchronous operator. Real software work needs taste, constraints, review, and exception handling, while the repetitive execution should happen in parallel off to the side.

## Solution

Director turns the developer into the director of a small agent pod: you speak architectural intent, and the system routes work into specialized parallel agents for UI, backend, data, and design. When work hits a subjective fork or real blocker, Director proactively escalates by voice instead of silently failing or waiting for the next prompt. Corrections become Harness rules, so "mock the music data source" or "use flat matte UI" is captured once and enforced across the rest of the run.

## Demo

- **Moodboard pick:** Director opens the GenUI Canvas with Mixtape card material options, and the user chooses the visual direction by voice.
- **Dispatch:** Four agents fan out in the ambient Hive to build the playlist card UI, generator API, file-backed persistence, and theme system in parallel.
- **Blocker:** The backend agent hits missing music API credentials; Director interrupts and asks whether to wire keys or generate plausible local fake tracks.
- **Reveal:** The Canvas returns with a live Mixtape React artifact: enter a vibe, generate a stylized playlist card, flip the cover, hover tracks, and copy a share link.

## Architecture

- **Voice tier (`gpt-realtime-2`):** shipped as the Electron voice surface with ephemeral token minting, WebRTC scaffolding, terse Director persona, and tool-call routing in progress.
- **Planner tier (`gpt-5.5`):** scaffolded as the long-memory orchestration layer that maintains the Harness, decides when to ask the user, and writes world-state briefs across Realtime sessions.
- **Execution tier (Codex agents):** scaffolded for the hackathon demo with simulated agent state, Hive status, blockers, and Canvas outputs; the planned production path swaps the simulator for Codex SDK subprocesses.

## Tech stack

Electron + React + Tailwind + Framer Motion + Zustand + OpenAI Realtime API + Codex SDK (planned)

## Built in

5 hours during the OpenAI Voice Hackathon, May 2026

## GitHub

TODO

## Video

TODO
