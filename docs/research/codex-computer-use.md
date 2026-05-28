# Codex computer use — scope assessment for Director

> Investigation of OpenAI's "Codex computer use" (April–May 2026) against Director's hard constraints: workers never launch Electron, Main only launches inside automated tests, all hands-on verification is R4.
>
> Companion to `docs/research/codex-for-everything.md`. Anchors evidence on the most recent public OpenAI docs and announcements.

---

## TL;DR

**Codex computer use is not in scope for P5/P6/P7, and not a fit for Main's R4 either.** As of May 2026 it is a Desktop-App-only, ChatGPT-signed-in, macOS-only feature with no SDK or CLI invocation surface — it cannot be driven from a Node script and so cannot replace human eyes in R4. The lower-level Responses-API `computer-use-preview` tool *is* programmatically callable but is browser-shaped (Playwright/Docker harnesses), Tier 3+ gated, and explicitly poor on Electron apps. **Recommendation: add a single line to the post-ship roadmap, scratch it from the hackathon plan.**

---

## Capability snapshot

There are **two different things** sold under the "computer use" umbrella. Director needs to keep them separate.

### A. Codex App "Background Computer Use" (April 16 2026 launch)

- A **plugin inside the Codex Desktop App**. Invoked by typing `@Computer` or `@<AppName>` into a Codex thread, or asking Codex in natural language ("open Figma and …").
- Codex spawns its own cursor that sees, clicks, and types in parallel with the user's own work. Multiple agent cursors can run side-by-side.
- Runs **locally on the user's Mac** using macOS Accessibility + Screen Recording permissions. Not a hosted VM.
- **No CLI flag, no SDK method, no Responses-API toggle exposes this surface.** The `@openai/codex-sdk` npm README and the Codex SDK reference describe only `startThread` / `run` / `runStreamed` — text in, JSONL events out. The official Codex docs route computer use through `developers.openai.com/codex/app/computer-use`, and the existing OpenAI Developer Community thread "Feature request: Headless Codex computer-use (server-side UI automation)" confirms it is *currently* tied to a desktop user session, not headless.
- Recent changelog (2026-05-21) adds "remote computer use" — Codex can drive desktop apps after the Mac locks, with safeguards (short-lived auth, covered displays, relock on local input). Still Desktop-App-anchored, not script-anchored.

### B. Responses-API `computer-use-preview` tool

- A model + tool exposed through `developers.openai.com/api/docs/models/computer-use-preview`. Callable via `POST /v1/responses` with `tools: [{ type: "computer" }]` and `model: "computer-use-preview"` (or `gpt-5.5`).
- The model **returns structured actions** (`click`, `type`, `drag`, `move`, `scroll`, `keypress`, `wait`, `screenshot`). It does not execute them. **You write the harness** that takes a screenshot, sends it, receives an action, executes it (typically Playwright or xdotool in a Docker container with Xvfb), captures a new screenshot, and loops.
- OpenAI's own `openai-cua-sample-app` is **"intentionally browser-focused"** and explicitly excludes workspace patching / native app control.
- 8,192-token context. Does not support streaming, structured outputs, or fine-tuning.

The Codex App's computer-use plugin almost certainly wraps (B) under the hood, but OpenAI does not expose that wrapper to non-Desktop-App callers.

---

## Access + gating

| Surface | Gating | Notes |
|---|---|---|
| Codex App computer use | ChatGPT Plus / Pro / Business / Edu / Enterprise sign-in inside the Desktop App; macOS 13+; **not available in EEA, UK, Switzerland at launch**; one-time grant of macOS Accessibility + Screen Recording permissions; per-app approval (with "Always allow") during first use | No spec'd per-call cost — debits ChatGPT plan credits like the rest of Codex |
| Responses-API `computer-use-preview` | **API Tier 3+** (i.e. the org has spent enough to graduate past Tier 2); Organization Verification (identity check) for advanced models; Responses-API endpoint enabled on the org | $3 / 1M input tokens, $12 / 1M output tokens (separate from base model token spend) |

Director's user is on Tier 5 with a verified org (assumed — typical for the hackathon profile), so (B) is technically reachable. (A) is reachable for anyone with the Desktop App and a ChatGPT plan.

---

## Security model

- **(A) Codex App:** runs as the signed-in macOS user with that user's Accessibility + Screen Recording + Automation entitlements. Per-app approval prompts surface for first use; "Always allow" toggles persist. OpenAI's own guidance: *"Treat visible app content, browser pages, screenshots, and files opened in the target app as context Codex may process,"* and *"Do not treat computer use as a blank check for unsupervised desktop automation. Avoid it for sensitive personal accounts, irreversible production actions, private data movement, payments, credential handling."* Locked-mac use is allowed only on active, trusted turns with covered displays and instant relock on local input.
- **(B) `computer-use-preview`:** sandboxing is *your responsibility*. The reference architecture is a Docker container with Xvfb + a browser, or a disposable VM. The model only returns action JSON.

For Director — which already runs Codex sub-agents inside `workspace-write`-sandboxed git worktrees — neither surface inherits or extends that sandbox. (A) would have the *user's full machine* in scope, and (B) requires us to stand up our own VM-or-container harness.

---

## Fit assessment for Director

Answering the three structured questions:

**(a) Can it drive Electron apps?**
- **(A)** Theoretically yes — Codex App computer use can drive "any macOS app", which includes Electron. In practice, two independent sources flag Electron as the worst case for computer-use automation: flat accessibility trees, and aggressive focus-grabbing on input events ("if an app insists on coming to the foreground when it gets a click event, the background illusion breaks"). Driving Director-the-Electron-app would also race the user's own clicks, since (A) shares the user's macOS session.
- **(B)** No, not without us shipping an Electron-aware harness ourselves. The reference sample is browser-only.

**(b) Can it be invoked from a Node script, headless / unattended?**
- **(A)** No. There is no CLI flag, no SDK method, no Responses-API plumbing for the Desktop-App's computer-use plugin. An active OpenAI Developer Community feature request ("Headless Codex computer-use (server-side UI automation)") confirms this is the open gap, with no roadmap response from OpenAI staff in the thread.
- **(B)** Yes — `POST /v1/responses` is callable from anywhere. But "callable" ≠ "useful for Director": we would still need a screenshot loop + an OS input executor wired into our test harness. ~1–2 weeks of work for an Electron-shaped one; nobody's open-sourced an Electron CUA harness as of this writing.

**(c) Latency + cost.**
- (A) is interactive — each action is seconds to tens of seconds (screenshot → vision → plan → click). A full "open the app, summon Director, verify Hive renders" sequence is on the order of 1–3 minutes per pass.
- (B) cost is **additive**: $3 / 1M input + $12 / 1M output on top of the base model. Each loop iteration sends a full screenshot (typically 1500–3000 input tokens for a 1280×800 PNG), so a 30-action verification run is roughly $0.10–$0.40 per run on top of `gpt-5.5` token spend. Not prohibitive, but not free either.

Hard constraint check: Director's working rule says workers never launch Electron, and Main only launches inside automated tests. Computer use is *the wrong shape* for that constraint — it's a screenshot-and-click loop on a *running, visible* Electron window driven by a signed-in macOS session. Even (B) doesn't change that: replacing the user with a vision-LLM loop is more brittle, slower, and more expensive than what R4 already does (the user, watching).

---

## Recommendation

**Scratch from P5/P6/P7. Add one line to the post-ship roadmap. Do not design for it now.**

Justification:

1. **It doesn't unlock R4 automation.** The hard constraint that motivated the question — "could computer use replace human eyes in R4?" — is unmet on both surfaces. (A) can't be invoked from a script. (B) can, but driving an Electron app through it requires us to *build the harness we're trying to avoid*, and Electron is the documented worst case.
2. **The cheaper R4 replacement already exists.** Playwright + `electron` driver (the standard `_electron` API) gives Director deterministic, fast, scriptable Electron verification. That's the right tool for the "Main launches the app only inside an automated test" loophole. We should pursue that *before* reaching for vision-driven computer use.
3. **The natural Director-side computer-use story is post-ship, not pre-ship.** "Maya can actually use the Mixtape app she just shipped" is the obvious extension of the dogfood narrative — and it slots in once (a) OpenAI ships headless computer-use (the open community ask), or (b) we wrap (B) ourselves around a hosted browser harness for sub-agent self-verification of web outputs. Either way it's a v2 feature.

Roadmap entry to add (proposed wording for `docs/roadmap.md`, post-ship section):

> **Computer-use sub-agent self-verification.** Once OpenAI exposes Codex computer use through the CLI/SDK (currently community-requested, no ETA), or once a Playwright-shaped wrapper around `computer-use-preview` becomes the right cost/latency, let each sub-agent verify its own UI output. First cut: browser-shaped (web apps the Mixtape track produces). Native macOS / Electron is gated on better Electron accessibility-tree support upstream.

---

## Open questions / things I couldn't verify

1. **Does OpenAI plan to expose the Desktop App's computer-use plugin via the SDK in the next 6 months?** No public roadmap signal either way. The Developer Community feature request is unanswered by staff.
2. **Latency numbers for (A).** No first-party benchmark published; my "1–3 min per verification pass" estimate is inferred from analogous Anthropic Computer Use + community-reported (B) loop times. Not firsthand.
3. **Whether `computer-use-preview` is now `computer-use-2026-04` or has been re-named.** The model name reference page still lists `computer-use-preview`; the announcement page is 403 to WebFetch.
4. **EEA/UK availability timeline for (A).** "Soon" per the launch post; no concrete date.
5. **Whether Codex sub-agents themselves can summon (A) from inside their own turn** (i.e. a Codex sub-agent invokes computer use as a tool on the same Mac). Not documented; assumed no, since (A) requires the Codex Desktop App as the host.

---

## Sources

Retrieved 2026-05-27.

- [Codex for (almost) everything — OpenAI announcement](https://openai.com/index/codex-for-almost-everything/) (HTTP 403 to WebFetch; details cross-confirmed via secondary sources below)
- [Codex App — Computer Use docs](https://developers.openai.com/codex/app/computer-use)
- [Codex SDK reference](https://developers.openai.com/codex/sdk) — confirms no computer-use surface in the SDK
- [Codex Changelog](https://developers.openai.com/codex/changelog) — 2026-05-21 "Remote computer use" entry
- [openai/codex Releases](https://github.com/openai/codex/releases) — only mention is "Added CUA requirements subsection for locked computer use" in 0.133.0, documentation-only
- [computer-use-preview model reference](https://developers.openai.com/api/docs/models/computer-use-preview) — Tier 3+, $3/$12 per 1M tokens, 8192-token context, no streaming
- [Computer use tool guide (Responses API)](https://developers.openai.com/api/docs/guides/tools-computer-use) — confirms harness-on-your-side model
- [openai/openai-cua-sample-app](https://github.com/openai/openai-cua-sample-app) — "intentionally browser-focused", excludes workspace patching
- [OpenAI Developer Community — feature request: headless Codex computer-use](https://community.openai.com/t/feature-request-headless-codex-computer-use-server-side-ui-automation/1379625) — community ask, no staff response
- [Codex Computer Use Update April 2026 — open-techstack](https://open-techstack.com/blog/codex-computer-use-update-april-2026/)
- [How to Use Codex 2026 — ai.cc](https://www.ai.cc/blogs/how-to-use-codex-openai-2026-update-computer-use-guide/)
- [Codex Background Computer Use — buildmvpfast](https://www.buildmvpfast.com/blog/openai-codex-background-computer-use-desktop-agent-2026)
- [Building Computer Use Agents with OpenAI's API — RIIS](https://www.riis.com/blog/building-computer-use-agents-with-openai-api) — Electron accessibility-tree and focus-grabbing limitations
- [Companion: docs/research/codex-for-everything.md](./codex-for-everything.md)

---

*Last updated: 2026-05-27.*
