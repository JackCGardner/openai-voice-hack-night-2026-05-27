# Review B — UI + Strip + Surface switcher

> Reviewer: independent sonnet agent (claude-sonnet-4-6). Date: 2026-05-27.

## Summary

The BrowserWindow flags, surface switching logic, and auto-resize gating are all correctly implemented and match spec. The critical bugs are two contract mismatches: `AgentRow` uses `agent.accentColor` from the live state type but the contracts.md § 2.1 spec defines the field as `accent`, and `DormantStrip` / `ListeningStrip` hardcode 12px pill geometry even when the window is resized to 38px for listening/thinking states — meaning the pill never visually expands. The design-token colors are exact matches to spec.

---

## Findings

### 🔴 BLOCKERS

#### B-1: Agent identity field name mismatch — `agent.accentColor` vs contracts § 2.1 `accent`

**What**: `contracts.md § 2.1` defines the Agent type with field name `accent: string`. The actual `shared/state.ts` defines it as `accentColor: \`#${string}\``. `AgentRow.tsx` (line 87) reads `agent.accentColor` — which is correct relative to the live code — but the contracts document has not been updated. Two workers could independently reference the spec and implement against the stale field name.

**Where**: `apps/director/src/shared/state.ts` line 89, `apps/director/src/renderer/src/components/AgentRow.tsx` line 87, `docs/contracts.md § 2.1`.

**Why it matters**: The contracts.md spec says `accent` (bare string, no hex constraint). The real type says `accentColor` (typed as `` `#${string}` ``). Any worker reading § 2.1 to write a new AgentRow variant or sim patch will use the wrong field name and produce a runtime `undefined` on the accent color, causing names to render invisibly (transparent text).

**Suggested fix**: File a `docs(contracts): clarify Agent.accent → Agent.accentColor` commit that aligns § 2.1 with the live type, including the hex-template constraint. The code itself is internally consistent — only the doc is wrong.

---

#### B-2: Small-state pill geometry never expands for `listening` / `thinking` / `speaking`

**What**: `DormantStrip`, `ListeningStrip`, and `SpeakingStrip` all render via `.strip-small` (defined in `globals.css` line 157): `width: 12px; height: 180px`. The window IS resized to 38×180 by the `STRIP_DIMS` resize effect in App.tsx. But the React pill inside still uses `.strip-small` which is hardcoded to 12px wide. The pill will be centered in a 38px-wide window but remain 12px — leaving 13px of transparent void on each side.

**Where**: `apps/director/src/renderer/src/styles/globals.css` lines 156–163, `apps/director/src/renderer/src/components/ListeningStrip.tsx` line 131 (uses `.strip-small`), `apps/director/src/renderer/src/components/ThinkingStrip.tsx` lines 63–80 (uses hardcoded `width: 38, height: 180` inline — this one is actually correct).

**Why it matters**: `ThinkingStrip` correctly hardcodes 38px inline style. `ListeningStrip` and `SpeakingStrip` (which delegates to `ListeningStrip`) use `.strip-small` which is hardcoded at 12px. The Pencil mockup (WTc1y — Listening) shows the waveform bars spanning the full pill width. With `.strip-small` the bars are contained inside a 12px container inside the 38px window — the visual does not match spec.

**Suggested fix**: Either add a `.strip-medium` class (`width: 38px; height: 180px`) and apply it in `ListeningStrip` and `SpeakingStrip`, or — better — make `ListeningStrip` use `width: 100%; height: 100%` so it fills whatever the window provides, consistent with how `ThinkingStrip` and `HiveStrip` work.

---

### 🟡 MAJOR

#### B-3: `connecting` state missing from `STRIP_DIMS` → resize fires with undefined dims

**What**: `STRIP_DIMS` in App.tsx (line 25) includes `connecting: { width: 38, height: 180 }` — this is correct. However `contracts.md § 2.2` defines the `connecting` variant as `{ kind: 'connecting'; attempt: number; since: number }` while the actual `shared/state.ts` (line 43) matches that. The code is fine here; but the contracts doc's `connecting` entry is `{ kind: 'connecting' }` (no `attempt`, no `since`) — it's structurally incomplete, which could cause a W3 worker to produce a connecting state that doesn't carry `attempt`, breaking the store's legal-transition guard.

**Where**: `docs/contracts.md § 2.2` line 99, `apps/director/src/shared/state.ts` lines 43–44.

**Why it matters**: Any worker reading the contracts doc and setting strip state to `'connecting'` will emit `{ kind: 'connecting' }` which TypeScript will reject at the store boundary. No runtime bug in existing code, but a coordination trap for the next contributor.

**Suggested fix**: `docs(contracts): clarify StripState.connecting` to add `attempt: number; since: number`.

---

#### B-4: `AgentRow` uses raw `agent.accentColor` from store, bypassing the named-agent CSS var lookup

**What**: `AgentRow.tsx` line 87 sets name color to `agent.accentColor` directly. The `ChatSurface.tsx` has a `agentAccent()` helper (lines 28–35) that maps agent id/name to CSS vars (`var(--accent-maya)`, etc.), which gives the theming system control. `AgentRow` skips this and uses the raw hex stored in the agent record. If an agent is dispatched with a wrong accentColor (e.g. the sim hardcodes `#7AC0FF` per the JSDoc comment in state.ts line 89), the Pass 4 identity colors will not apply.

**Where**: `apps/director/src/renderer/src/components/AgentRow.tsx` line 87.

**Why it matters**: The design spec (Pass 4, § identity table) requires Maya=#E07856, Jin=#4A9E9C, Cleo=#C99550, Wren=#9670A0. If the sim or a Codex agent sets a wrong accentColor, there is no defensive layer in AgentRow to normalize it to the spec colors. ChatSurface has this guard; HiveStrip's AgentRow does not.

**Suggested fix**: Add the same `agentAccent()` lookup to AgentRow (or extract it to a shared utility in `lib/`) and use `var(--accent-*)` CSS vars rather than the raw hex field for the four canonical agents.

---

#### B-5: Hotkey `CommandOrControl+Shift+Space` conflicts with macOS reserved chord

**What**: `main/index.ts` line 175 registers `CommandOrControl+Shift+Space` as the global summon hotkey. `docs/contracts.md § 9.1` explicitly lists `⌘⇧Space` as a potentially-reserved macOS chord ("Character viewer — most setups; usable in dev but unreliable"). The spec also says the Hyper chord `⌃⌥⌘Space` should replace it.

**Where**: `apps/director/src/main/index.ts` line 175.

**Why it matters**: On some macOS setups (especially with third-party launchers, Raycast, Alfred, or the system Character Viewer bound to this chord), the hotkey silently fails to register — and line 179 only logs a `console.warn` rather than surfacing the conflict to the user as a Canvas picker (per § 7C-1 resolution). The app ships broken summon with no user-facing feedback.

**Suggested fix**: Per § 7C-1, test the hotkey registration and on failure open a Canvas `options_picker` with alternative chords. Or switch default to `Control+Alt+Cmd+Space` as § 9.1 recommends.

---

#### B-6: `App.tsx` useEffect for Realtime event bridging (micMode / speaking transitions) has no `surface` gate

**What**: The large useEffect at App.tsx line 128 (which listens to `client.on('micMode', ...)` and `client.on('event', ...)` to drive store transitions) has no `if (surface !== 'strip') return` guard. The auto-connect and hotkey effects (lines 71 and 94) are correctly gated. The event bridge is not.

**Where**: `apps/director/src/renderer/src/App.tsx` lines 128–203 — the `[client]` dep-array effect has no surface check at the top.

**Why it matters**: When the chat-debug window is open, this effect still fires, but the chat window has no Realtime peer (auto-connect is gated). The client object in chat will be in `idle`/`closed` state, so `client.on()` listeners are registered but should no-op safely. However if the chat window somehow receives a `micMode` event (e.g. via IPC broadcast), it would attempt store mutations from the chat surface, potentially corrupting strip state visible in both windows (they share the same Zustand store instance per window, so this is bounded — but it is still an unintended listener). More importantly, the escalation event listener (lines 211–257) has no gate either, meaning the chat window will attempt to inject `conversation.item.create` into the Realtime client from the chat surface context.

**Suggested fix**: Add `if (surface !== 'strip') return;` at the top of both the event-bridge effect and the escalation effect, consistent with the auto-connect and hotkey patterns.

---

### 🟢 MINOR

#### B-7: `DormantStrip` does not handle `connecting` state distinctly

**What**: StripSurface maps `connecting` to `<DormantStrip />`. The Pencil mockup only covers dormant; there is no distinct connecting visual. The UX plan (Pass 2) describes "hairline ring pulses around Strip while connecting" but no such component or variant exists. `DormantStrip` will render the slow breathing pulse — visually identical to dormant.

**Where**: `apps/director/src/renderer/src/components/StripSurface.tsx` line 43.

**Why it matters**: Cosmetic degradation for now; real gap for the interaction state matrix. Low urgency at hack night.

---

#### B-8: `HiveStrip` has no empty-agents guard

**What**: `HiveStrip.tsx` renders `<AnimatePresence>` over `agents.map(...)`. When agents is empty (e.g., hive state entered before any agents are dispatched), the strip renders a 280×420 empty panel. The UX plan does not spec this case.

**Where**: `apps/director/src/renderer/src/components/HiveStrip.tsx` lines 67–72.

**Why it matters**: Minor — the empty panel is visible (border + background) but blank. Low urgency.

---

#### B-9: `globals.css` has `--status-done` mapped to `#9B9BA0` (neutral) but AgentRow `STATUS_FILL` uses this for `done` and `killed`

**What**: `AgentRow.tsx` line 11 maps `killed` to `var(--text-tertiary)` and `done` also maps there via `var(--status-done)`. Both resolve to neutral grey. The contracts § 2.1 AgentStatus type includes `'idle'` but `state.ts` does not — instead it has `'spawning'` and `'thinking'` which the contracts doc lacks.

**Where**: `apps/director/src/shared/state.ts` line 76, `docs/contracts.md § 2.1`.

**Why it matters**: Contracts drift. `idle` listed in contracts does not exist in code; `spawning` and `thinking` exist in code but not in contracts. Any new worker implementing against § 2.1 will produce illegal status values.

**Suggested fix**: `docs(contracts): clarify AgentStatus` to remove `idle` and add `spawning`, `thinking`, `killed`.

---

#### B-10: `§ 9.3` inline hex violation in `ListeningStrip` and `ThinkingStrip`

**What**: `contracts.md § 9.3` forbids hex literals in components — all colors must use CSS vars. `ListeningStrip.tsx` line 136 sets `background: '#0E0E10D9'` as a raw hex. `ThinkingStrip.tsx` line 68 sets `border: '0.5px solid rgba(110, 148, 232, 0.25)'` and line 87 sets `background: 'radial-gradient(...rgba(110,148,232,1)...'` as raw values rather than referencing `var(--status-thinking)`.

**Where**: `apps/director/src/renderer/src/components/ListeningStrip.tsx` line 136; `apps/director/src/renderer/src/components/ThinkingStrip.tsx` lines 68, 87.

**Why it matters**: Styling convention violation, not a runtime bug. Makes theme changes harder.

---

## Visual fidelity against Pencil

### Dormant Strip (EodJh)

Pencil shows a slim vertical pill on the right side with a very subtle blue-purple gradient glow at center, dark near-black surface. The React implementation in `DormantStrip.tsx` matches: `.strip-small` is 12×180px with 6px radius, and `strip-pulse` animates a `linear-gradient(to bottom, var(--pulse-soft) 0%, var(--pulse-mid) 50%, var(--pulse-soft) 100%)` with `box-shadow` glow. The geometry, color, and motion spec align. The only gap is that the pill in Pencil appears to have a slightly visible border hairline; the code uses `border: 0.5px solid var(--border-subtle)` which matches.

### Listening Strip (WTc1y)

Pencil shows the full pill width filled with vertical bar segments in bright green, spanning the full 38px width. The React `ListeningStrip` renders 21 bars in a flex column inside `.strip-small` — but `.strip-small` is hardcoded to 12px. This is **the B-2 blocker**: the bars are visually confined to 12px, not the 38px shown in Pencil. The bar color (`var(--status-working)` = `#58D68D`) matches the Pencil green exactly.

### Thinking Strip (TiVyu)

Pencil shows a wide pill (~38px) with italic reasoning text fading to the left and a blue pulsing dot centered in the pill. The React implementation matches: `ThinkingStrip.tsx` renders the trail text in a column to the left (with recency-based opacity from 0.25 to 0.95) and a `motion.div` with `radial-gradient(circle, rgba(110,148,232,...))` for the blue orb. The text is right-aligned and fades correctly. Width is hardcoded to 38px inline style — correct, unlike the Listening case. Geometry matches Pencil well.

### Hive Working (v2ONzK)

Pencil shows four agents in vertical rows: Maya (coral name, green disc), Jin (teal name, green disc), Cleo (ochre name, green disc), Wren (plum name, green disc). Each row has disc · name · role tag on the right, with italic trail text and file breadcrumbs below. The React `AgentRow` matches this layout: status disc left, name with `agent.accentColor`, role upper-cased right, italic trail, mono file breadcrumbs. Pencil shows all agents with green discs (all working) — the code's `STATUS_FILL.working = var(--status-working)` which is `#58D68D` matches. One discrepancy: Pencil shows the disc and name on the same horizontal row with role tag pushed right via spacer — the React code implements this correctly with `flex: 1` spacer. Visual match is strong.

---

## Architectural concerns

1. **App.tsx is accumulating surface-specific logic** that belongs in hooks. The escalation bridge, the Realtime event bridge, and the dev key switcher are all inline useEffects. Per § 13.2, these should be extracted to `hooks/useEscalationBridge.ts`, `hooks/useRealtimeEventBridge.ts`, etc. The file is already 433 lines and growing; the next worker to touch it faces merge risk.

2. **Shared `getSurface()` is a module-level function called once on mount** — it does not react to URL changes. Since strip and chat are separate windows with separate page loads, this is acceptable for now, but if the renderer ever supports in-page navigation this will silently break.

3. **No `disconnected` / `error` strip variant** — both fall through to `DormantStrip`. The interaction state matrix (Pass 2) specifies distinct amber-ring behaviors for these. This is a known gap but should be tracked.

---

## What's working well

- **BrowserWindow flag hygiene is correct.** Strip window has `frame: false`, `transparent: true`, `vibrancy: 'under-window'`, `type: 'panel'`, `closable: false`, `sandbox: false`, and critically does NOT have `titleBarStyle: 'hidden'`. The § 9.2 traffic-light conflict is avoided cleanly.
- **Surface switching is correct.** `getSurface()` reads the query param; `?surface=chat` routes to ChatSurface; chat-debug window correctly appends `?surface=chat` in both dev and prod paths (lines 63 and 65 of `chat-debug-window.ts`).
- **Auto-connect and hotkey both gated to strip surface.** Lines 72 and 95 in App.tsx both have `if (surface !== 'strip') return` — the dual-peer bug is prevented.
- **Auto-resize gated to strip surface.** Lines 263–269 in App.tsx gate `bridge.window.resizeStrip` behind `if (surface !== 'strip') return`. Chat window cannot trigger resize.
- **StripSurface component mapping is exhaustive.** The `default` branch uses `never` exhaustiveness check (line 57), so any new `StripStateKind` added without updating the switch will be a TypeScript compile error.
- **Design tokens are exact.** Every CSS var in `globals.css` matches the Pass 5 table including agent accents (Maya `#e07856`, Jin `#4a9e9c`, Cleo `#c99550`, Wren `#9670a0`). The `@theme` block correctly bridges them to Tailwind v4 utilities.
- **Reduced-motion is honored** in every animated component via `useReducedMotion()`.
- **Global hotkey uses no macOS-reserved Hyper chords for dev shortcuts.** The `Control+Alt+Cmd+{M,A,H,X}` dev canvas shortcuts are correctly in the Hyper chord space. The only concern is the primary summon `CommandOrControl+Shift+Space` (B-5).
