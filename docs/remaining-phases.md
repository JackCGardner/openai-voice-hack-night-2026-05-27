# Director — Remaining Phases (P5 · P6 · P7)

> Status as of 2026-05-27 ~8.5h into a 16h budget. P0–P4 base shipped + reviewed + inline-fixed.
> Re-cut from a fresh read of `docs/vision.md` and `docs/architecture.md` after spotting gaps vs. the original full plan.

## Why this re-plan

The original roadmap had P5 (polish) + P6 (resilience) and stopped. Reading the architecture doc end-to-end surfaced load-bearing pieces that fell off the wagon during the hackathon scope contraction:

- **Planner durability** (`responses.compact`, `previous_response_id` chaining, post-compaction health-check probe). Currently the planner is single-shot per call — fine for a 5-minute demo, broken for any session >5min.
- **Continuity primitives** (`state.snapshot.json`, `meta.json`, resume-on-launch). Currently every launch is fresh; the "Pick up Mixtape, or start fresh?" moment from vision.md doesn't exist.
- **Error degradation surfaces** (Canvas error boundary, mic-permission-denied card, API-key-missing form, Codex hang watchdog, worktree merge fan-in). The first WiFi blip / stuck agent / wedged session today = silent UI failure.

P5 stays as cosmetic/interaction polish. **P6 expanded** to cover all session-lifecycle and error-degradation work. **P7 added** for planner durability — architecturally distinct enough to warrant its own lane and parallelizable with everything else.

---

## Sequencing

```
 ─── Done ─────────────────── R3 ──── P5 / P6 / P7 (parallel) ──── R4 ──── ship
 0h ─ 8.5h                    9.5h    9.5h ─────── 14.5h           14.5h    16h

 Main (ORCH)  [reviews ]    R3       P6.4 → P6.5 ──────── → P7.3   R4
 W1 (MAIN)    [done bars]      .     P7.1 → P7.2  (finishes early)
 W2 (VOICE)   [done bars]      .     P6.1 → P6.2
 W3 (STATE)   [done bars]   P4.c  →  P6.3 → P6.3b → P5.2
 W4 (UI)      [done bars]      .     P5.1 → P5.3
 W5 (CANVAS)  [done bar ]   P4.d  →  P6.6
```

R3 gates on **W3 P4c (Codex events → store)** + **W5 P4d (Mixtape dogfood)** landing. After R3 clears, the P5/P6/P7 batch fires in parallel.

**Main owns the critical path** post-R3 — the three cross-cutting items (P6.4 watchdog, P6.5 fan-in, P7.3 health-check probe) all touch ≥3 subsystems and benefit from full integration context. W1 keeps the contained planner work (P7.1 chaining + P7.2 compaction) and finishes early at ~11.5h; could pick up extras if needed.

---

## Phase 5 — Polish (UI + audio)

Cosmetic + interaction polish. Demo-elevating, not demo-blocking. From `docs/ux-design.md` Passes 5/6 and `docs/vision.md` §2-§3.

### 5.1 Captions component (W4)
**Files** (NEW): `apps/director/src/renderer/src/components/Captions.tsx`
**Behavior:** subscribes to the assistant transcript stream from the realtime client; renders the last ~12 words of Director's spoken output as a fading subtitle, anchored 24px below the Strip. Each word fades in 80ms, persists 1.4s past final word, fades out 240ms. Stops rendering when transcript is silent for >2s. No background — just text-shadow + drop-shadow for legibility over any wallpaper.
**IPC / state:** reads from existing zustand `transcript` slice; no new channels.
**Mount point:** `StripSurface.tsx` (sibling to Strip, not child — avoids App.tsx merge conflict).
**DoD:** captions track Director's narration during a `consult_director` round-trip; remain legible over both light and dark wallpapers; do not flicker on punctuation.

### 5.2 Audio cue synthesis (W3)
**Files** (NEW): `apps/director/src/renderer/src/audio/synth.ts` · `audio/cues.ts` · `audio/index.ts`
**Cues** (per `docs/ux-design.md` Pass 5 sound palette):
- `confirm` — single 880Hz sine, 80ms, –12dB. Fires on tool-call success acknowledgement.
- `tick` — 1320Hz square, 30ms, –18dB. Fires on agent micro-task progress.
- `escalation` — 660→440Hz descending dual-tone, 180ms each, –10dB. Fires on `agent.blocked` + proactive announcement.
- `done` — C major triad arpeggio (523/659/784Hz), 60ms each, –12dB. Fires on `agent.done`.
- `halo` — soft 220Hz sine fade in/out, 1200ms, –20dB. Fires on session-rotation swap.
**Implementation:** pure Web Audio API; no audio files. `synth.ts` exposes `playCue(name, opts?)`. `cues.ts` wires zustand state transitions → `playCue`.
**Wiring:** `App.tsx` imports the wiring module once at mount; no per-component code.
**DoD:** every state transition documented above plays exactly its cue, exactly once per transition; no overlap glitches; respects a global mute toggle (env var or settings).

### 5.3 Polish bundle (W4)
**Strip-as-Canvas-handle** (`docs/ux-design.md` Pass 1 decision 1B): when Canvas is `open`, the Strip becomes a draggable handle that moves the Canvas window. Cursor changes to `grab` on hover.
**Hover-to-peek on dormant Strip:** mouse-enter on dormant Strip while no work in flight → expand briefly (200ms) to show current goal + active agent count; collapse on mouse-leave + 800ms delay. Suppress during `listening`/`speaking`.
**Minimal-seed onboarding (3A-1):** first launch (no `~/.director/sessions/` dir): Canvas slides out with a 3-field form — project root path (file picker), voice preference (marin/cedar), API key (text). On submit, write meta.json + initial harness.json with `agentIdentities` populated. Director then speaks: "Ready. What are we building?"
**DoD:** all three behave per spec; onboarding writes the side store correctly; relaunch with seeded sessions skips onboarding.

---

## Phase 6 — Continuity & resilience (expanded)

All session-lifecycle and error-degradation work. From `docs/architecture.md` §3, §4, §6, §8, §9.

### 6.1 Session rotation @ T+55 with World State Brief (W2)
**File:** `apps/director/src/main/realtime.ts` (extend with `rotationCoordinator`) + `apps/director/src/renderer/src/realtime/client.ts` (add `rotationClient`).
**Protocol** (per architecture.md §4):
1. Lifecycle FSM (renderer) hits T+55:00 → emits `session.rotationRequested` IPC.
2. Main builds the **World State Brief** from the side store:
   - Active harness rules verbatim (from `harness.json`)
   - Active agents + statuses (from `agents/<id>.json`)
   - Current goal (from `meta.json:currentGoal`)
   - Last canvas state (from `canvas.last.json`)
   - Last 6 transcript items (from tail of `transcript.jsonl`)
   - Elapsed time
3. Main mints `Session_B` via `/v1/realtime/client_secrets` with **identical** `session.update` payload (model, voice, instructions, tools) so prompt caching survives.
4. Main → renderer: `session.rotationReady` event with `{ token, expiresAt, brief }`.
5. Renderer opens a second `RTCPeerConnection` to `Session_B`. On `oai-events` open, sends `conversation.item.create` with the Brief as a `system` role item; waits for `conversation.item.created` ack.
6. Renderer watches audio output; at next ~200ms VAD-silent window (or immediately if `vadActivity === 'silent'`) swaps `<audio>` srcObject and mic track from Session_A → Session_B.
7. Sends Session_A a graceful close; tears down peer.
8. FSM → `'live'`; append `rotation.complete` to `orchestrator.jsonl`.
**Fallback:** if Session_B mint or SDP fails, stay on Session_A. At T+59:30 surface soft macOS notification ("session reset coming"). At T+60:00 force cold rotation with ~1s audible silence + halo cue.
**DoD:** rotation runs invisibly at T+55 in a real session; total swap latency <200ms; transcript continuity across sessions verified by reading transcript.jsonl tail and confirming no gap; fallback path tested by killing Session_B mint mid-rotation.

### 6.2 Disconnect / reconnect UX (W2)
**File:** `apps/director/src/renderer/src/realtime/client.ts` (extend with retry loop) + `App.tsx` (UI for degraded state).
**Trigger:** WebRTC `iceConnectionState` → `disconnected`/`failed`, or data channel close.
**Behavior** (per architecture.md §9):
- FSM → `'degraded'`. Strip dims to grey-30%; tray icon adds a small red dot.
- Mic is **muted** while degraded — no utterances reach a dead channel.
- The user's last utterance (held in zustand `pendingUtterance` if mid-VAD) is queued for replay.
- Retry with exponential backoff: 1s, 2s, 5s, 10s. After 30s of failure: single macOS notification ("Director offline — reconnecting").
- On reconnect (data channel reopens): FSM → `'live'`; Strip restores; mic re-enables; if `pendingUtterance` exists, replay it as a `conversation.item.create` with `role: user`, then `response.create`.
- After 3 failed retries (~50s total): FSM → `'degraded'` persistent. Notification offers `--text-fallback` mode (Canvas card with text input as input surface).
**DoD:** unplug network → grey Strip within 2s. Reconnect within 30s → resumes; pending utterance replays. Sustained disconnect → text-fallback Canvas card.

### 6.3 state.snapshot.json + meta.json writers (W3)
**File:** `apps/director/src/main/side-store.ts` (extend).
**state.snapshot.json:**
- Full `DirectorState` minus ephemeral fields (no `vadActivity`, no in-flight tool call IDs).
- Debounced 1.5s. Every state mutation marks dirty; a single writer drains at most every 1.5s.
- **Force-flush** on: `app.quit`, session rotation, after every `responses.create` completion.
- Atomic write (`.tmp` + `fsync` + `rename`).
- Carries `schemaVersion: 1`.
**meta.json:**
- `{ projectPath, targetAppDir, name, createdAt, updatedAt, appVersion, currentGoal }`.
- Atomic-written on goal change OR app version change OR project path change.
- Carries `schemaVersion: 1`.
**DoD:** kill the app mid-session (SIGKILL on Electron PID); inspect `~/.director/sessions/<id>/` — `state.snapshot.json` reflects state ≤1.5s before kill; `meta.json` reflects the most recent goal.

### 6.3b Resume on launch — "Pick up or start fresh?" (W3)
**Files:** `apps/director/src/main/index.ts` (boot path) + `apps/director/src/main/side-store.ts` (`findResumableSession`) + Canvas form component.
**Protocol** (per architecture.md §8 + vision §3C-1):
1. On boot, main reads `~/.director/sessions/*`; finds most recent by `meta.updatedAt`; checks `<7 days old`.
2. If found: emit `session.lifecycleChanged: 'boot'` with `{ resumeAvailable: true, sessionPreview: { projectName, currentGoal, lastActiveAt } }`. Pre-load `state.snapshot.json` into renderer (don't apply yet — just stage).
3. Renderer shows dormant Strip immediately; Director speaks: "Pick up *<projectName>*, or start fresh?" Canvas slides out with a 2-option picker (`options_picker` component).
4. **User selects "Resume":** main hydrates harness + transcript tail + decisions ledger + current goal into the planner's first `responses.create` instructions+input block. Active agents do NOT auto-respawn (architectural decision — they're in the snapshot but stale). Canvas dismisses; FSM → `live`.
5. **User selects "Start fresh":** main creates a new session directory (timestamp slug); old session stays on disk for later resume. FSM → `live`.
**DoD:** kill app → relaunch within 7 days → "Pick up X?" plays; resume restores harness + last goal + transcript tail; start-fresh creates a new session dir without touching old.

### 6.4 Codex hang watchdog (Main — cross-process)
> **Owner:** Main, not W1. Reason: this touches three subsystems — codex-pool stopwatch, planner proactive injection, realtime narration. Main has full integration context; a worker would have to ramp on all three.

**File:** `apps/director/src/main/codex-pool.ts` (extend).
**Behavior** (per architecture.md §6, §9):
- Per agent: stopwatch from last stdout line + last `task_progress` event.
- `>60s` with no output: emit `agent.hangSuspected` IPC. Orchestrator (planner) receives a proactive injection: synthesize a system message "Maya has produced no output for 60 seconds — narrate this to the user and offer to kill or extend."
- Director (realtime) narrates: "*Maya seems stuck. Kill or give it more time?*"
- User says "kill it" → planner calls `dispatch_agent` tool's kill branch → pool sends SIGTERM, 5s grace, then SIGKILL. Agent status → `error`; worktree archived to `~/.director/abandoned/<timestamp>-<agent>/`.
- User says "more time" → reset stopwatch; bump threshold to 120s for the next escalation.
**DoD:** set DIRECTOR_TEST_HANG=maya env var to make Maya hang on dispatch → after 60s Director narrates; "kill it" voice command resolves; agent moves to `error`; worktree shows in abandoned dir.

### 6.5 Worktree merge fan-in (Main — cross-cutting)
> **Owner:** Main, not W1. Reason: the auto-merge-vs-Canvas-approval policy decision is a system-level call. Touches pool · Canvas · state · git. The most cross-cutting item in P6.

**File:** `apps/director/src/main/codex-pool.ts` (extend) + new `apps/director/src/main/worktree-merger.ts`.
**Behavior** (per architecture.md §6 + open Q #12):
- When all agents in a dispatched batch reach `done`: pool emits `batch.completed` with the list of worktree paths + their HEAD shas.
- Two paths:
  1. **Auto-merge (default for trivial)**: if all worktrees touched non-overlapping files, fast-forward each into the integration branch in dispatch order. Append `decisions.jsonl` with `kind: 'auto-merged'`.
  2. **Approval required (overlap detected, or harness rule `requireMergeApproval`)**: render Canvas `code_preview` component with the combined diff; user says "ship it" or "keep maya, drop jin's changes". Selected subset is merged; rejected worktrees archived.
- After merge: `git worktree remove` each successfully-merged path. Failed merges (conflicts) stay on disk; orchestrator narrates "Merge conflict in `foo.tsx` — open the worktree manually."
**DoD:** dispatch 2 non-overlapping agents → batch.completed fires → both fast-forward into integration branch; dispatch 2 overlapping agents → Canvas diff preview shows; "ship it" applies all; "keep maya only" applies maya's and archives jin's.

### 6.6 Canvas error boundary + degradation cards (W5)
> **Owner:** W5 (moved from W4). Reason: the four new files are all Canvas components — W5's wheelhouse. W4 stays focused on Strip-anchored polish.

**Files:** `apps/director/src/renderer/src/canvas/CanvasApp.tsx` (wrap in `<ErrorBoundary>`) + new Canvas components: `MicDenied.tsx`, `ApiKeyMissing.tsx`, `RotationFailed.tsx`, `CanvasError.tsx`.
**Behavior** (per architecture.md §9):
- **CanvasErrorBoundary** wraps every Canvas component render. On caught error: render compact `CanvasError` card with error message + "retry" button + voice apology playback ("Couldn't draw that.")
- **MicDenied:** rendered when `getUserMedia` rejects. Card with instructions + macOS "System Settings → Privacy → Microphone" deeplink button (`x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`). Director says: "I can't hear you. Mic permission needed."
- **ApiKeyMissing:** rendered when token endpoint returns 401. Card with text input for API key + save button. Submit writes to `.env` (hackathon mode) or macOS keychain (production mode, gated by env flag `DIRECTOR_USE_KEYCHAIN=1`). Director says: "OpenAI key needed."
- **RotationFailed:** rendered when session rotation fails 3 times. Soft card with "Session will reset in ~1s — sorry for the blip" message. Auto-dismisses after cold rotation.
**DoD:** revoke mic permission → MicDenied card on next launch with deeplink; bad API key → ApiKeyMissing card on boot; mid-canvas component crash → ErrorBoundary catches, shows CanvasError card, retry recovers.

---

## Phase 7 — Planner durability (NEW)

W1-only lane. Closes the compaction-finding gap from `docs/architecture.md` §5 + `docs/research/compaction.md`. Currently the planner is single-shot per `consult_director` call — every call starts fresh, no chained context, no compaction strategy, no `orchestrator.jsonl` log.

**Why this matters:** the load-bearing architectural claim is that "the orchestrator's compacted memory is opaque, so the disk is the truth." Today we have the disk truth but no orchestrator memory at all. The planner can't say "I already considered that approach in turn 3" because there is no turn 3 — every consult is turn 1.

### 7.1 `previous_response_id` chaining + orchestrator.jsonl (W1)
**File:** `apps/director/src/main/planner.ts` (extend).
**Behavior** (per architecture.md §5):
- First consult of a session: `responses.create` with full `input` array (system + harness rules + user query). Capture `response.id`.
- Subsequent consults: `responses.create` with `previous_response_id: lastResponseId` + new `input` (just the user query). `instructions` field still carries harness rules rebuilt from side store on every call (instructions live outside the items array, never compacted).
- After every `responses.create` AND `responses.compact`: append to `orchestrator.jsonl` a line: `{ at, kind: 'response' | 'compaction', responseId, previousResponseId, model, usage, summary?: string }`.
- Persist `lastResponseId` to zustand (in `session.orchestrator.previousResponseId`) and to the next state.snapshot.json so it survives a restart.
- On boot resume: read the most recent `orchestrator.jsonl` entry → set `lastResponseId`. Continue chain.
- Use `store: false` everywhere — we manage state.
**DoD:** ask Director two related questions ("plan a sharing feature" → "OK do that but for free tier only"). Inspect `orchestrator.jsonl`: second call's `previousResponseId` equals first call's `responseId`. Restart app mid-conversation → ask follow-up → chain continues.

### 7.2 `responses.compact` at quiescent moments (W1)
**File:** `apps/director/src/main/planner.ts` (extend) + new `apps/director/src/main/compaction-runner.ts`.
**Behavior** (per architecture.md §5 + research/compaction.md):
- Pass `context_management: [{ type: 'compaction', compact_threshold: 180000 }]` on **every** `responses.create` (safety net — server compacts if we forget to).
- **Manually** call `responses.compact(...)` at quiescent moments — we choose the timing, not the model:
  - After any tool-call batch whose cumulative output >50k tokens (track via usage counts in `orchestrator.jsonl`).
  - On user idle ≥90s with token count >80k (zustand has lastUtteranceAt + tokenCount).
  - **Pre-rotation** (precondition for session rotation, since rotation injects a brief into Session_B and we want a clean planner state).
- Compaction is asynchronous and non-blocking — the next consult queues behind it.
- Append compaction event to `orchestrator.jsonl`.
**DoD:** simulate >50k tokens of tool output → compaction fires within 1s of quiescence; before a manual session rotation, compaction runs first; `orchestrator.jsonl` shows the compaction line with previous and new `response.id`.

### 7.3 Post-compaction health-check probe (Main — cross-cutting reads)
> **Owner:** Main, not W1. Reason: the probe cross-checks against four subsystems (meta.json + agents/*.json + transcript.jsonl tail + planner re-injection path). Reading across that many surfaces and judging "is this a mismatch worth re-injecting?" is exactly the kind of cross-cutting integration call Main owns.

**File:** `apps/director/src/main/compaction-runner.ts` (extend).
**Behavior** (per architecture.md §5):
- After every compaction: fire a synthetic single-turn `responses.create` (cheap model OK, e.g. gpt-5-mini): "*Without using tools, in 3 lines: what is the current goal, what agents are active, what was the most recent user instruction?*"
- Cross-check the response against:
  - `meta.json:currentGoal`
  - `agents/*.json` where status ∈ `{spawning, working, blocked}`
  - tail of `transcript.jsonl` filtered to `role: user`
- On match: noop. On mismatch: re-inject a fresh system message into the next consult containing the must-preserve blocks (goal + active agents + recent user turn). Append `orchestrator.jsonl` with `kind: 'health-check-mismatch'` for diagnostics.
- Probe failure (5xx, timeout) is non-fatal — log and continue; user-visible state stays correct because instructions are rebuilt from side store every call.
**DoD:** force a compaction during testing → probe runs within 5s → `orchestrator.jsonl` shows the probe result. Artificially desync the planner (inject a fake compaction blob with stale goal) → probe detects mismatch → next consult includes the re-injection block.

---

## Known scope cuts (deliberately NOT in P5/P6/P7)

These are real gaps vs. `vision.md` / `architecture.md`, intentionally deferred. Flag immediately if any becomes a demo-blocker.

### 1. 3-tier collapsed to 2-tier
Original vision had Realtime → `consult_director` → planner-with-tools (`dispatch_agent`, `update_harness`, `render_canvas`, `record_decision`, `list_active_jobs`, `read_decisions`, `set_current_goal`, `force_compaction`, `consult_realtime`). Today Realtime holds the action tools directly; planner only narrates. The planner can't autonomously dispatch work or paint Canvas mid-reasoning — it has to return narration, then Realtime decides whether to act.
**Impact:** "deep director" became "deep narrator." Lost: autonomous multi-agent dispatch from a single user prompt. Workaround: user can still chain ("plan a sharing feature" → "OK do it") in two turns instead of one.
**Reversal cost:** ~6h of W1 work — add the 9 tools to the planner, wire results back to Realtime via the existing function_call_output path. Not in P5/P6/P7; revisit post-ship.

### 2. No XState lifecycle FSM
`architecture.md` §2 specified Zustand + XState (XState wrapping `session.lifecycle: boot → connecting → live → rotating → degraded → quitting`). Shipped Zustand-only. Illegal lifecycle transitions (e.g. `live → boot`) are silently possible. No 250ms CRC heartbeat between renderer + main mirrors.
**Impact:** demo-tolerable. Long-running production would catch real bugs.
**Reversal cost:** ~3h. Add XState machine in `apps/director/src/renderer/src/state/lifecycleMachine.ts` + reconciliation poll in `apps/director/src/main/state-mirror.ts`.

### 3. No macOS Keychain
API key currently in `.env`. `architecture.md` §11 called for keychain via `keytar`. Hackathon-acceptable; not ship-acceptable.
**Impact:** acceptable for demo + dev. Ship blocker for distribution (dmg + auto-update).
**Reversal cost:** ~1.5h. `keytar` wrapper in `apps/director/src/main/keychain/apiKey.ts` + migration path from `.env` → keychain on first launch.

### 4. MCP servers directly on Realtime
`architecture.md` §11 open Q. All heavy tools stayed behind planner. Direct MCP on Realtime would let trivial reads (file open, git status) skip the planner round-trip.
**Impact:** v2 demo feature; not v1. Currently every read goes through `consult_director`.
**Reversal cost:** ~4h. Realtime MCP support varies by model version — check current API surface.

### 5. Worktree base-branch pre-flight + diff approval
`architecture.md` §11 open Q #11, #12. Currently worktree is added off current HEAD with no check for uncommitted changes (will fail loudly if dirty). No Canvas diff-approval UI before merge — P6.5 fan-in defaults to auto-merge.
**Impact:** P6.5 auto-merge is the riskiest item shipping in this batch — needs at minimum a "uncommitted changes — stash or commit?" Canvas form before dispatch, and a Canvas diff card before merge for opt-in approval mode.
**Reversal cost:** ~2h. Folded as a P6.5 stretch goal.

---

## Ownership map

| Task | Phase | Owner | File(s) | New or extend |
|---|---|---|---|---|
| 5.1 Captions | P5 | W4 | components/Captions.tsx, StripSurface.tsx | NEW + extend |
| 5.2 Audio cues | P5 | W3 | renderer/src/audio/* | NEW |
| 5.3 Polish bundle | P5 | W4 | DormantStrip.tsx + canvas form + onboarding | extend |
| 6.1 Session rotation | P6 | W2 | main/realtime.ts + renderer/realtime/client.ts | extend |
| 6.2 Disconnect/reconnect | P6 | W2 | renderer/realtime/client.ts + App.tsx | extend |
| 6.3 snapshot+meta writers | P6 | W3 | main/side-store.ts | extend |
| 6.3b Resume on launch | P6 | W3 | main/index.ts + side-store.ts + Canvas | extend + NEW |
| **6.4 Hang watchdog** | P6 | **Main** | main/codex-pool.ts + main/planner.ts + realtime narration | extend |
| **6.5 Merge fan-in** | P6 | **Main** | main/codex-pool.ts + main/worktree-merger.ts + Canvas | extend + NEW |
| **6.6 Error boundary + cards** | P6 | **W5** | canvas/CanvasApp.tsx + 4 new Canvas components | extend + NEW |
| 7.1 Chaining + jsonl | P7 | W1 | main/planner.ts + main/side-store.ts | extend |
| 7.2 responses.compact | P7 | W1 | main/planner.ts + main/compaction-runner.ts | extend + NEW |
| **7.3 Health-check probe** | P7 | **Main** | main/compaction-runner.ts (cross-checks side store + planner re-inject) | extend |

### Anti-collision (per `docs/contracts.md` § 13)

The rebalance introduced two new shared-file points between Main and W1. Both are sequential within the post-R3 window:

- **`main/planner.ts`** is touched by both W1 (P7.1 + P7.2 first) and Main (P6.4 watchdog narration injection + P7.3 probe re-injection — later). W1 lands 9.5–11.5h; Main reads from a stable planner module starting at 10h (P6.4) and again at 13.5h (P7.3). The 30-minute overlap (10–10.5h) is the only risk window — Main waits for W1 P7.1 to land before extending planner.ts.
- **`main/codex-pool.ts`** is touched by Main only (P6.4 + P6.5 sequentially). No worker overlap.
- **`main/compaction-runner.ts`** is a new module created by W1 in P7.2 (10.5–11.5h); Main extends it for P7.3 starting at 13.5h. Clean hand-off.
- **`main/side-store.ts`** is touched by W3 (P6.3 + P6.3b) and W1 (P7.1 adds orchestrator.jsonl writer). Append-only marker convention from contracts § 13.1 applies.
- **`apps/director/src/renderer/src/canvas/CanvasApp.tsx`** is touched by W5 (P6.6 error boundary wrap) and by Main (P6.5 Canvas diff approval card — but Main mounts via a new component, doesn't modify CanvasApp itself).
- **`App.tsx`** is touched by W4 (P5.1 Captions mount + P5.3 polish wiring) only. Append-only marker convention applies.
- **`main/realtime.ts`** is touched by W2 (P6.1 rotation + P6.2 reconnect) and Main (P6.4 narration trigger). Main reads from a stable IPC surface W2 builds; coordinate the channel name in contracts.md before P6.4 starts.

---

## R3 prerequisites (gate before P5/P6/P7 fire)

1. **W3 P4c**: Codex events → store actions. `apps/director/src/renderer/src/state/ipcSync.ts` subscribes to `codex.fileChange` / `codex.turnCompleted` / `codex.error` events and dispatches the existing `addAgent / updateAgent / blockAgent / completeAgent` store actions.
2. **W5 P4d**: Mixtape dogfood. Flip `DIRECTOR_USE_REAL_CODEX=1`. Dispatch Jin (backend) against `examples/mixtape` to implement `app/api/mixtape/[id]/route.ts`. Verify iframe Canvas punchline shows a completed flippable card.

R3 verifies:
- `consult_director` audio narration round-trip
- 4 real Codex subprocesses spawn with their AGENTS.md personas
- file_change / turn.completed events update Hive in real time
- side store on disk (harness.json + decisions.jsonl + agents/<id>.json + transcript.jsonl)
- Mixtape Canvas iframe shows a real artifact built by a real agent

After R3 passes, P5/P6/P7 fire as a parallel batch.

---

## R4 ship criteria (full demo dry-run)

A presenter runs the demo cold:

1. Launch the app. State is restored from a prior session ("Pick up Mixtape, or start fresh?"). Select Resume.
2. ⌘⇧Space (or Hyper hotkey) summons Director. Speak: "plan the share-link feature for Mixtape."
3. Director responds with one-word ack ("Thinking."), `consult_director` fires, planner returns a structured plan; Director narrates the plan summary verbatim.
4. Speak: "OK do it." Director dispatches 2 agents (e.g. Jin backend + Maya frontend). Strip enters Hive view; agent nodes spin.
5. After ~30s one agent hits a blocker (mocked or real). Audio escalation cue plays. Director speaks unprompted: "Jin needs the storage backend — JSON file or DB?"
6. Speak: "JSON file." Director updates harness via `update_harness`. Agent unblocks.
7. After ~60s both agents complete. P6.5 fan-in fires; auto-merge happens (no overlap); decisions.jsonl appended.
8. Canvas slides out with the rendered share page. Speak: "ship it." Director merges to integration branch.
9. **At minute 5:** the demo wraps. (At minute 55, rotation would fire invisibly — verified in a separate longer test.)

R4 also verifies the off-the-happy-path items:
- Kill the process mid-session → relaunch → state restored from snapshot
- Disconnect WiFi mid-utterance → grey Strip + queued utterance → reconnect → utterance replays
- Force a Codex hang → watchdog + voice escalation → "kill it" resolves
- Force compaction during testing → health-check probe runs → orchestrator.jsonl shows the line

---

## Open questions (need a human call before dispatch)

1. **P6.5 fan-in default — auto-merge vs always-approve?** Recommendation: auto-merge for non-overlapping changes; Canvas approval card for any overlap or any agent touching files outside its declared scope. Defer until W1 reaches P6.5.
2. **P7 health-check probe model — gpt-5-mini vs gpt-5?** Recommendation: mini for cost (the probe is a 3-line check, not a planning call). Confirm before W1 P7.3.
3. **6.3 schema versioning — write migrators now or defer?** Recommendation: defer until first schema bump; the `schemaVersion: 1` field is forward-compatible.
4. **6.6 ApiKeyMissing — write to `.env` or keychain?** Recommendation: env flag `DIRECTOR_USE_KEYCHAIN=1` gates it; default to `.env` for hackathon, keychain for ship build.
5. **P5.3 onboarding — when does it fire?** Recommendation: any time `~/.director/sessions/` is empty AND `meta.json:initialized` is missing. Idempotent — never repeats once a session exists.

---

## Out-of-scope for this 16h budget

- Reversing the 3-tier collapse (would add 6h, biggest semantic win but doesn't block demo)
- XState lifecycle FSM (3h, catches real bugs in long-running prod)
- Keychain (1.5h, ship blocker but not demo blocker)
- MCP-on-Realtime (4h, v2 feature)
- Schema migrators (defer until first schema bump)
- DMG packaging + auto-update (distribution work; separate post-ship phase)

These are deliberate scope calls — each documented in **Known scope cuts** above with a reversal-cost estimate.
