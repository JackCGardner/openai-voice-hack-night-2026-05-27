# Director — Orchestrator Playbook

> Main (the orchestrator role) reads this before each review gate. Codifies what I do, what I don't do, and what passes a gate.

## Modes

### Mode 1 — Workers mid-flight (between gates)

Don't dispatch new code-touching work. Don't edit `apps/director/src/shared/*`. Don't touch files inside any active worker's "CAN touch" boundary.

Useful work in this window:
- Read code workers are touching (so review is fast when they report).
- Update `docs/contracts.md` for clarifications (never breaking changes).
- Pre-draft the NEXT gate's dispatch prompts.
- Run the app locally to stay familiar.
- Monitor `git log` for commits.

Do NOT:
- Commit to files workers are actively editing.
- Send new prompts to workers mid-task.
- Make sweeping refactors.

### Mode 2 — A worker reports done

When a worker replies with "done":
1. `git fetch && git pull origin main` to absorb their commits.
2. `git log --oneline | head -10` — note their hashes.
3. `git show <hash>` for each new commit — read the diff.
4. Don't mark the gate "passed" — wait until the whole batch reports.

### Mode 3 — At a review gate

When all workers in the batch have reported, run the gate-specific smoke sequence (below). One of three outcomes:
- **PASS** → dispatch the next batch.
- **PARTIAL** → re-dispatch only the failed lane(s) with a focused follow-up prompt.
- **FAIL** → halt all next-batch dispatch until root cause resolved.

### Mode 4 — Pre-dispatch (before sending a new prompt)

1. Check Gantt collision window — any active worker on conflicting files?
2. Check `shared/ipc.ts` marker — any new channels needed? Pre-stake if so.
3. Check `contracts.md § 8.2` — does the new task touch a file outside the worker's role? If yes, add a path-vs-role row first.
4. Write the prompt using `contracts.md § 12` template.

### Mode 5 — Cross-cutting integration (only Main does this)

Some work spans 3+ workers' boundaries. Main owns:
- Wiring planner service (W1) ↔ consult_director tool (W2) ↔ side store (W3) at R3.
- Resolving merge conflicts between worker commits on shared files.
- Final integration polish that doesn't fit in any single worker's lane.

When doing cross-cutting work:
1. Verify all dependent commits are on `main`.
2. Pull latest.
3. Write the glue across multiple ownership boundaries.
4. Update `contracts.md` if integration revealed new shapes.
5. Verify end-to-end before pushing.

### Mode 6 — Cross-worker conflict (rare)

If two workers' commits collide (e.g., both edit `shared/ipc.ts` outside the marker), or one worker steps on another's verified work:
1. Halt all in-flight workers.
2. Resolve on `main`.
3. Add an entry to `docs/retrospective.md` describing the failure.
4. Re-dispatch only the clobbered worker.

---

## Review gates — verbatim smoke sequences

### R1 (P1 → P2) — Integration sound?

Pre-req: Workers 1, 2, 3 all report done. Pull latest.

```bash
cd /Users/jackgardner/Development/openai-voice-hack-night-2026-05-27
git pull origin main
pnpm install
pnpm --filter director dev
```

Then in the running app:

| # | Step | Pass criterion |
|---|---|---|
| 1 | App launches | No crash; chat window appears; no red errors in devtools console |
| 2 | Bridge check | In devtools console: `typeof window.director === 'object'` |
| 3 | Sub-bridges | `window.director.tool.call`, `.realtime.mintToken`, `.window.resizeStrip` all exist |
| 4 | Mic connect | Click Mic → status pill progresses `closed → minting → getting-mic → connecting → connected` within 3s |
| 5 | Mic permission | macOS prompts; grant. Re-connect succeeds |
| 6 | Voice round-trip | Say "hello" → audible AI response within 3s |
| 7 | Tool route — render_canvas | Click "Show Moodboard" → Canvas window opens with 3 tiles |
| 8 | Tool route — same again | Click "Show Artifact" → Canvas with Mixtape card; click cover → flips |
| 9 | Canvas dismiss | Click outside Canvas or press `⌃⌥⌘X` → Canvas hides |
| 10 | Tool route — dispatch | Press `T` → "Maya" appears in Hive sidebar |
| 11 | Tool route — harness | Press `H` → Canvas flashes "Rule added: No gradients ever" then auto-dismisses |
| 12 | Sim start | Press `D` → 4 agents (Maya/Jin/Cleo/Wren) populate Hive over ~5s |
| 13 | Sim escalation | Wait ~50s → Jin's row turns amber/blocked |
| 14 | Escalation injection | Within 2s of #13, AI speaks unprompted asking the resolution question |
| 15 | Escalation resolve | Press `R` → Jin's row returns to green; sim continues |
| 16 | Sim completes | Within ~3 min, all 4 agents show "done" status |
| 17 | Typecheck | `pnpm --filter director typecheck` clean |
| 18 | Build | `pnpm --filter director build` clean |

**PASS**: 17/18 minimum, with #14 (escalation injection) and #4 (mic connect) mandatory.

**PARTIAL recovery rules**:
- If #2–6 fail → Worker 1 re-dispatch (bridge bug)
- If #7–11 fail → Worker 3 re-dispatch (tool routing)
- If #14 fails → Worker 2 re-dispatch (escalation injection)

**FAIL**: any of mandatory items fail → halt P2 dispatch, debug with the failing worker.

### R2 (P2 → P3+P4) — Strip restored?

Pre-req: Workers 1, 4, 5 report done on P2.

| # | Step | Pass criterion |
|---|---|---|
| 1 | App launches | Strip appears as transparent overlay on right edge of primary display (NOT a chat window) |
| 2 | Dormant pulse | Dark glass with soft cyan breathing pulse (per Pencil EodJh) |
| 3 | No traffic lights | No red/yellow/green dots on Strip; no close button |
| 4 | Vibrancy works | Strip shows wallpaper through (test with bright + dark wallpapers) |
| 5 | Summon | `⌃⌥⌘Space` (or whatever's bound) → Strip transitions to listening state |
| 6 | Listening waveform | Live mic-driven waveform appears (per Pencil WTc1y) |
| 7 | AI speaking | After AI response begins, strip transitions to speaking state |
| 8 | Auto-resize | Strip resizes per state: 12×180 → 38×180 → 280×420 |
| 9 | Hive view | Press `D` → strip widens to Hive with 4 agents |
| 10 | Canvas position | `⌃⌥⌘M` → Canvas appears to the left of Strip (not centered) |
| 11 | Chat tray | Tray menu → "Show Chat (debug)" → second window opens with chat UI |
| 12 | Pencil parity | Each strip state matches Pencil mockup visually (subjective) |

**PASS**: 11/12 minimum, with #1, #3, #5, #6, #9 mandatory.

### R3 (P3 + P4 → P5) — 3-tier alive?

Pre-req: P3 + P4 workers report done.

| # | Step | Pass criterion |
|---|---|---|
| 1 | All R1+R2 smoke still passes | Regression check |
| 2 | consult_director tool | Say "build a Mixtape sharing feature" → AI uses consult_director |
| 3 | Reasoning narration | Hear AI narrate the planner's reasoning ("weighing two approaches…") |
| 4 | Real Codex spawn | At dispatch, 4 actual `codex` child processes appear in `ps aux` |
| 5 | AGENTS.md per worktree | Each Codex worktree has an AGENTS.md with the agent's persona |
| 6 | file_change events | Codex `file_change` events update Hive in real time |
| 7 | Real Mixtape build | Director's agents actually complete `examples/mixtape/components/PlaylistCard.tsx` or similar |
| 8 | Side store on disk | `~/.director/sessions/<id>/harness.json` exists after a session |
| 9 | Session rotation prep | (P6 not yet — skip if not in scope) |

**PASS**: 7/9, with #2, #4, #7 mandatory.

### R4 (P5 + P6 → ship) — Ready to record?

Pre-req: P5 + P6 workers report done.

Full 5-min Mixtape demo runs end-to-end with audio cues + captions + zero glitches. See `docs/demo-timeline.md` for the canonical beats.

---

## Things Main commits on its own (no worker dispatch)

- `docs/*` updates (retrospective, roadmap, contracts.md clarifications)
- `docs/build-plan.html` worker status updates after gates pass
- The `shared/ipc.ts` append-only marker pre-stakes (before P3+P4)
- Cross-cutting integration glue (R3 specifically — connecting W1+W2+W3's pieces)

## Things Main NEVER does

- Edit `apps/director/src/main/*` (unless cross-cutting integration after R3)
- Edit any renderer code outside cross-cutting integration windows
- Modify `apps/director/src/shared/*` above the append-only marker
- Dispatch a worker without checking the Gantt collision window

---

## Current state log

> Updated by Main after each gate.

- **2026-05-27 ~19:00 PDT**: P1 dispatched. Worker 1 (bridge fix) + Worker 2 (escalation injection) + Worker 3 (tool routing smoke) all in flight. Mid-Mode-1. R1 pending workers' completion.
