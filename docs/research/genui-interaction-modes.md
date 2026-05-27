# GenUI Canvas — Prose Components & Voice/Click Duality

Follow-up to `genui-schema.md`. Adds two layers the original 7-component set glossed over: components for decisions that live in *language* rather than visuals, and the interaction contract that makes every component work equally well via voice or click.

## Part 1 — Prose-heavy Component Variants

The original schema leans on `options_picker` for any text choice, but a card with a 12-word `description` collapses when the trade-off is a paragraph. We add two new components plus one `style` variant on the existing picker.

### 1. `prose_options` (new)

**When to use:** Architectural / library / structural decisions where each option needs 1–3 paragraphs of reasoning. The user needs to *read* before they can decide.

```ts
interface ProseOptionsProps {
  question: string;                     // "How should we handle auth?"
  context?: string;                     // optional 1-line framing
  options: Array<{
    id: string;
    heading: string;                    // "NextAuth"
    summary: string;                    // single bold sentence under heading
    rationale: string;                  // 1–3 paragraphs of markdown
    tradeoffs?: { pros?: string[]; cons?: string[] };  // bulleted, max 3 each
    badge?: "recommended" | "fast" | "risky" | "novel";
    voice_synonyms?: string[];          // ["nextauth", "the first one", "battle tested"]
  }>;                                   // 2–4 items
  recommendation_id?: string;           // orchestrator's pick, gets a soft halo
}
```

**Visual:** 2–4 wide glass cards stacked vertically (never side-by-side — prose needs line length). Heading 18px, summary 14px medium, rationale 13px regular, 1.55 leading. Pros in soft green, cons in soft amber. Recommended card has a faint neon-green outer ring.

**Interactive:** Yes. Response: `{ value: { option_id: string, note?: string } }`. Click anywhere on a card to pick. The card's voice_synonyms array is the orchestrator's resolution table for utterances.

**Example payload:**
```json
{
  "component": "prose_options",
  "component_id": "auth-1",
  "props": {
    "question": "How should we handle auth?",
    "options": [
      {
        "id": "nextauth",
        "heading": "NextAuth",
        "summary": "Drop-in, opinionated, three providers wired in 20 min.",
        "rationale": "Battle-tested across thousands of Next.js apps. Sessions, CSRF, JWT rotation, OAuth out of the box. We trade control for a known-good harness — every edge case has a GitHub issue with a fix.",
        "tradeoffs": { "pros": ["Zero crypto code"], "cons": ["Heavy dep tree"] },
        "badge": "recommended",
        "voice_synonyms": ["nextauth", "the first one", "the safe one"]
      },
      {
        "id": "middleware",
        "heading": "Session-cookie middleware",
        "summary": "150 lines of our own code, total ownership.",
        "rationale": "Sign a session token, HttpOnly cookie, verify in middleware. No deps, no magic — and no community when it breaks at 3am.",
        "tradeoffs": { "pros": ["Tiny, auditable"], "cons": ["We own every CVE"] },
        "voice_synonyms": ["middleware", "roll our own", "the lighter one"]
      }
    ],
    "recommendation_id": "nextauth"
  }
}
```

### 2. `copy_variants` (new)

**When to use:** Short text choices — taglines, button labels, microcopy, error messages, empty states. The decision is *vibe*, not logic. Visuals would only get in the way.

```ts
interface CopyVariantsProps {
  question: string;                     // "Share-button copy?"
  context?: string;                     // "Used on every mixtape card"
  variants: Array<{
    id: string;
    text: string;                       // the actual copy
    annotation?: string;                // "playful, gen-z" — italic muted note
    voice_synonyms?: string[];
  }>;                                   // 2–6 items
  allow_freeform?: boolean;             // shows a "type your own" input
}
```

**Visual:** Each variant rendered at the size and weight it would appear *in the wild* (a button label as an actual button, a tagline in display weight). 11px italic annotation under each. Selected pulses, others fade to 40%. No card chrome — just typography on glass.

**Interactive:** Yes. Response: `{ value: { variant_id: string } | { freeform: string } }`. Voice utterances tend to *be* the chosen text ("pass the aux"), matched on `text` or `voice_synonyms`.

**Example payload:**
```json
{
  "component": "copy_variants",
  "component_id": "share-btn-1",
  "props": {
    "question": "Share button copy?",
    "variants": [
      { "id": "vibe", "text": "Send this vibe", "annotation": "warm, gifty", "voice_synonyms": ["vibe", "the warm one"] },
      { "id": "aux", "text": "Pass the aux", "annotation": "playful, gen-z", "voice_synonyms": ["aux", "the playful one"] },
      { "id": "link", "text": "Drop the link", "annotation": "neutral", "voice_synonyms": ["link", "the boring one"] }
    ],
    "allow_freeform": true
  }
}
```

### 3. `decision_brief` (new)

**When to use:** Orchestrator wants to *propose* a single direction and get fast approval (or a redirect) rather than force a multi-option choice. Most decisions don't have multiple defensible options — they have one obvious move that needs blessing.

```ts
interface DecisionBriefProps {
  title: string;                        // "Modeling Mixtape tracks"
  thinking: string;                     // 1–3 short paragraphs of markdown
  proposal: string;                     // single bold sentence: what I will do
  risks?: string[];                     // max 3 bullets, the things that could bite us
  confirm_label?: string;               // default "Go"
  redirect_label?: string;              // default "Different direction"
}
```

**Visual:** Single wide glass card. Title 16px medium, thinking in body prose, proposal in a softly green-tinted strip. Two buttons: primary `Go`, secondary `Different direction` (opens freeform text/voice input).

**Interactive:** Yes. Response: `{ value: { confirmed: true } | { redirect: string } }`.

### 4. `options_picker` gets a `style` prop (variant, not new component)

Rather than bloat the schema with a "compact prose" component, extend the existing picker:

```ts
interface OptionsPickerProps {
  // ...existing fields...
  style?: "card" | "compact" | "prose-lite";  // default "card"
}
```

- `card` — current behavior.
- `compact` — single-line radio list for trivial picks (`light` / `dark` / `system`).
- `prose-lite` — 2–4 sentence `description` per option, no paragraph block. Sweet spot between `options_picker` and `prose_options`.

Rule of thumb: pick the lightest component that fits. `compact` for trivial, `card` for default, `prose-lite` for "needs a sentence," `prose_options` for "needs a paragraph," `decision_brief` for "I already have an answer."

---

## Part 2 — Voice ↔ Click Duality

The Canvas is rendered *because* voice alone is insufficient — eyes need a visual referent. But the user should never *have* to lift a finger. Every interactive component supports both modes with the same fluency.

### Cross-cutting principles

**Affordance — "or just say it."** Every interactive component renders a small mic glyph bottom-left with muted hint **"or say it"** (11px, 50% opacity). When the user starts speaking, glyph pulses neon green. This is the *only* persistent voice affordance — we don't decorate individual options. On Canvas open, the Realtime layer also speaks a one-line prompt (auto-derived from `caption` / `question` / `title`) so across-the-room users know what they're being asked.

**Naming hints — `voice_synonyms` per option.** Every interactive option exposes optional `voice_synonyms: string[]`. The orchestrator pre-populates these at tool-call time: positional (`"the first one"`, `"left"`), semantic (`"the matte one"`), badge-derived (`"the recommended one"`). Belt and suspenders — the orchestrator can resolve from rendered props alone, but pre-baked synonyms make resolution deterministic and prompt-free.

**Click feedback.** Click commits silently. Chosen element pulses once (200ms scale 1.0 → 1.03 with a soft green halo), others fade to 40%, panel auto-dismisses after 400ms. Realtime reads the choice back *minimally* — *"NextAuth, going."* — only if conversation is mid-flow. Silent user, silent click. No "Sure, going with..."

**Voice feedback.** When the orchestrator resolves an utterance to an option_id, it emits `canvas_highlight({ component_id, option_id })` a beat before the synthetic `canvas_response`. The Canvas plays the **resolution animation**: target scales to 1.05 with a neon-green outline (350ms fade), others dim, then the commit pulse fires. Total budget: 500ms. User *sees* their voice was heard before the panel dismisses, with a ~600ms barge-in window to say "no, the other one."

**Disambiguation.** Below confidence threshold, the orchestrator does *not* guess. It plays `canvas_highlight` on *all* candidates (dual halo, no commit) and speaks a tight clarifier: *"Matte or holographic — both are dark."* No modal, no extra UI. For stacked components, "the first one" resolves to the *top stack*; orchestrator can narrate scope ("in the auth options...") if needed.

**Race conditions.**
- **Click wins ties.** Click within 500ms of voice resolve on same option → click wins silently.
- **Click on a *different* option mid-voice-resolve** cancels the voice resolve. Orchestrator gets `voice_intent_dropped: true` so it apologizes naturally: *"Got it, cassette then."*
- **Voice starts mid-click dismiss:** ignored — utterance becomes new conversation, not canvas response.
- **Two voice utterances inside the resolution window:** last-wins, first animation cancels mid-flight.

**Cancel / dismiss.** Voice: "cancel" / "never mind" / "close that" / "back". Click: `Esc`, X button, click-outside. Both fire `canvas_response({ value: { dismissed: true } })` so the orchestrator handles uniformly.

**Multi-field forms.** Voice fills fields sequentially in one utterance ("the API key is sk_test_xyz, env is staging") — orchestrator parses field-by-field and emits `canvas_form_patch({ component_id, fields })` that streams values in with per-field slide-ins. Secret fields stay masked. User submits with "submit" / "send it" or clicks the button. Click and voice interleave freely.

**Accessibility.** `Tab` cycles, `Arrow` keys move within a group, `Enter` commits. Focus ring matches the selection halo at full opacity. Screen-reader labels mirror the Realtime prompt verbatim. Everything voice does, keyboard does; everything keyboard does, voice does.

### Per-component voice + click contracts

**`moodboard`** — Realtime speaks `title` + *"two on screen, say which."* Phrases: `"the matte one"`, `"the left"`, `"the second"`, `"go with neon"`, label substrings. Animation: target scales to 1.05 with neon border, others drop to 40%, 350ms. Race rule: standard.

**`options_picker` (all styles)** — Realtime speaks `question`. For `compact`, also speaks all labels ("light, dark, or system?"). Phrases: labels, positional, badge ("the recommended one"). Animation: selected card glows + rises 2px, 300ms. Race rule: standard.

**`prose_options`** — Realtime speaks `question` only; does *not* read rationales aloud (that's what the screen is for). If user says "read it to me," orchestrator narrates headings + summaries only. Phrases: heading words, positional, badge, semantic ("the lighter one" → resolves via summary keywords). Animation: chosen card halos, others slide 4px right + fade, 450ms — prose decisions feel weightier. Race rule: standard plus extended 1.2s barge-in window.

**`copy_variants`** — Realtime *reads each variant text aloud in sequence* with a tiny pause between, then *"which one?"* Phrases: the variant text itself ("pass the aux"), annotation ("the playful one"), positional, freeform ("how about *Send the wave*" → freeform path if enabled). Animation: chosen text pulses, others fade to 30%, tight 250ms. Race rule: freeform utterance overrides any pending preset click.

**`decision_brief`** — Realtime speaks the `proposal` verbatim plus *"go, or different direction?"* Confirm phrases: `"go"` / `"yes"` / `"ship it"` / `"do it"`. Redirect: `"different"` / `"actually,"` / `"no,"` / any substantive non-confirm utterance. Animation: confirm pulses the proposal strip green; redirect opens an auto-focused freeform input that accepts voice or text. Race rule: redirect path *never* auto-resolves on first utterance — silence-detection or click confirm commits.

**`code_preview`** — Realtime speaks `title` + *"approve, reject, or request changes?"* (only actions present). Phrases: `"approve"` / `"ship it"` / `"looks good"` / `"reject"` / `"request changes"` / `"change line N to..."` (parsed as request_changes + note). Animation: action button pulses, diff dims, 300ms. Race rule: `request_changes` via voice opens the note input pre-focused with a transcription stream.

**`form`** — Realtime speaks `title` + first field label only. Subsequent fields discovered visually or via free speech. Phrases: structured ("the API key is X, env is staging"), per-field, focus ("the env field"), submit ("submit" / "send it"), skip ("mock it" if `allow_skip`). Animation: filled values slide in left-to-right, label color shifts to "filled." Race rule: click on a field cancels any pending fill targeting a *different* field. Submit is idempotent.

**`artifact_preview`** — Realtime speaks `title` + `notes` + action prompt. Phrases: action verbs (`"ship"`, `"iterate"`, `"discard"`, `"good"`, `"again"`, `"trash it"`). Animation: action pulses, frame dims, 300ms. Race rule: embedded iframe absorbs clicks normally — only action-button clicks resolve the response.

---

## Open Questions

1. **Pre-baked `voice_synonyms` vs pure runtime resolution.** We propose both. Is the latency win worth the prompt complexity? Measure before committing.
2. **Realtime narration latency on Canvas open.** Spring animation (~280ms) vs TTS first-audio (~400–700ms) — may need to delay Canvas slide-in by 150ms to mask TTS warm-up so audio and visual land together.
3. **Disambiguation confidence threshold.** Too low → system feels hesitant; too high → confidently wrong. Needs A/B feel-testing.
4. **Barge-in windows.** 1.2s for `prose_options`, 600ms elsewhere — guesses that need live testing with humans who didn't write the spec.
5. **`copy_variants` freeform via voice.** Auto-commit ("Send the wave" → done) or populate freeform input first for visual confirm? Confirm is safer; auto-commit is faster.
6. **Form narration depth.** If user is across the room and a 4-field form slides in, do we read all labels aloud? Risks tedium vs risks the user being stuck.
7. **Multi-Canvas dispatch.** If two orchestrator tasks both want to render at once: queue, stack, or kill-the-older? Likely queue with a "+1 waiting" badge on the Strip.
