# Finish Spec — the two architecture fixes (image-gen + codex dispatch)

Status: **DECIDED**. This is the implementation contract for the FINISH-IT-FOR-REAL
pass. No mocks, no stubs, no LLM-calls-a-TS-function. Every capability the brain
needs is a real tool with a real executor that runs in the main process.

The two problems and their fixed designs:

- **A. Image generation** — the persona told the LLM brain to call
  `saveGeneratedImage()` (a TS function the brain *cannot* call); the hosted
  `imageGenerationTool` returned bytes nothing captured. **Fix: a real local
  `generate_image` function tool whose executor calls the OpenAI Images API,
  saves the bytes, and RETURNS a renderable image reference to the brain.**
- **B. Codex dispatch / working directory / worktree model** — dispatch
  hard-required a pre-existing git repo, targeted a fixed `$HOME`, and forced a
  worktree per agent. **Fix: dispatch into the brain's roaming cwd, `git init`
  non-repos, make worktrees opt-in (default = shared dir), auto-merge worktree
  agents back on completion.**

This doc also removes every "the LLM calls a TS function directly" instruction
from the persona (only `saveGeneratedImage` exists today; §C audits for others).

---

## Ground-truth findings (verified, not assumed)

These drive the decisions below; record them so the implementer doesn't re-derive.

1. **Canvas CSP blocks `file://`.** `apps/director/src/renderer/canvas.html` line 9:

   ```
   img-src 'self' data: blob:
   ```

   There is **no `file:` (or wildcard) source**. The Moodboard renders each cover
   as a CSS `background-image: url(...)` (`Moodboard.tsx` line 92), which is
   governed by `img-src`. The window is `contextIsolation: true`,
   `nodeIntegration: false`, `sandbox: false`, and `webSecurity` is left at its
   secure default (`canvas.ts` `webPreferences`, lines 116–125 — not disabled).
   The Moodboard's doc-comment *claims* `file:///…` works (lines 14–18, 35–40);
   **that claim is wrong under this CSP** and is the silent reason generated
   moodboards render blank tiles. → **`generate_image` MUST return a `data:` URL,
   not a `file://` URL.** Reliability over elegance: `data:` is in the CSP and
   needs zero window/CSP changes. (We do NOT relax CSP to allow `file:`; widening
   `img-src` on a transparent always-on-top panel that also loads `script-src
   'self'` is a needless attack surface, and `file:` URLs are also fragile across
   the dev `loadURL` vs prod `loadFile` paths.)

2. **The `openai` SDK is already a dep and resolves to v4.104.0** (the app's
   `^4.79.0`). It is imported as a **default export**: `import OpenAI from 'openai'`
   and constructed `new OpenAI({ apiKey })` — see `main/index.ts:35,690` and
   `compaction-runner.ts:34`. `client.images.generate(params)` returns
   `ImagesResponse` with `data[0].b64_json` when `response_format: 'b64_json'`.
   `gpt-image-1` **always** returns base64 (ignores `response_format`); `dall-e-3`
   returns base64 only when `response_format: 'b64_json'` is set. So the executor
   asks for base64 and never touches the expiring `url` field.

3. **The Agents-SDK `tool()` executor may return `Promise<unknown> | unknown`**
   (`@openai/agents@0.11.6` → `agents-core/dist/tool.d.ts:527`). The existing
   `show_canvas` tool already returns a plain `string`; the brain reads it as the
   tool result. So `generate_image` returns a **JSON string** the brain parses for
   the `image_url`. This matches the established pattern in `agent-brain.ts`.

4. **The brain's shell cwd is a private closure** — `currentCwd` inside
   `makeLocalShell` (`agent-brain.ts:267`). It persists across commands but is not
   exposed. Dispatch (`tool-router.ts` → `resolveTargetRepo(homedir())`) therefore
   cannot see where the brain roamed. → we expose it (see §B.1).

5. **Codex dispatch forces a worktree + a pre-existing repo.**
   `dispatchAgentCore` (`codex-pool-core.ts:303`) always calls `createWorktree`
   and starts the thread with `skipGitRepoCheck: false` (line 322).
   `createWorktree` (`codex-worktree.ts:94`) runs `git worktree add … <baseBranch>`
   against `targetRepo` and throws if it isn't a git repo. → both must become
   conditional (see §B).

6. **`mergeFanIn` already exists and is already wired** to fire on
   `batch_completed` via `codex-pool.ts onBatchCompleted` (lines 167–248), which
   auto-merges non-overlapping worktrees into `main` and calls
   `releaseBatchWorktrees`. We REUSE this; we do not rebuild it. The only gap is
   that `batch_completed` only synthesizes when agents are dispatched WITH a
   `batchId` AND in worktree mode — see §B.4.

---

## A. Image generation — real `generate_image` tool

### A.1 The tool (replaces the hosted `imageGenerationTool`)

Add a real local **function** tool to the brain's `tools` array, defined in
`agent-brain.ts` (the brain's own file — allowed in the FIX phase). It runs in the
main process, so it can call the OpenAI SDK and `saveGeneratedImage()` directly.

```ts
const IMAGE_MODEL = process.env.DIRECTOR_IMAGE_MODEL || 'gpt-image-1';
const IMAGE_SIZE_DEFAULT = '1024x1024';

const generateImageTool = tool({
  name: 'generate_image',
  description:
    "Generate ONE piece of concept art from a text prompt (mood, texture, hero " +
    "imagery, a brand look). Returns a renderable image_url (an inline data: URL) " +
    "plus a saved file path. Call this once per concept, collect the image_urls, " +
    "then call show_canvas('moodboard', …) with all of them. This is how you make " +
    "generative imagery — the voice layer cannot, and routes these requests to you.",
  parameters: z.object({
    prompt: z.string().describe('What to draw. Be vivid and specific.'),
    label: z
      .string()
      .nullable()
      .describe('Short human label for this concept (used in the saved filename).'),
    size: z
      .enum(['1024x1024', '1536x1024', '1024x1536', 'auto'])
      .nullable()
      .describe('Image size. Default 1024x1024. Use 1536x1024 for hero/landscape.'),
  }),
  async execute({ prompt, label, size }) {
    try {
      const result = await generateImageImpl({
        prompt,
        label: label ?? undefined,
        size: size ?? undefined,
      });
      // Return a JSON string (same pattern as show_canvas). The brain reads
      // image_url out of this and passes it into a moodboard concept.
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
```

Notes on the schema:
- Parameters are `z.string().nullable()` not `.optional()` — the Agents SDK runs
  with strict JSON-schema and `gpt-5.5` is steadier with explicit nullable fields
  than with absent ones. The executor coalesces `null → undefined`.
- `n` is deliberately NOT exposed: one image per call keeps the brain's loop
  simple and the moodboard assembly explicit ("generate each, then show one
  board"). The persona already drove the multi-concept loop this way.

### A.2 The executor (real code, main process)

A new function in `agent-brain.ts`. **It returns a `data:` URL** (the CSP-safe form
from §finding 1) AND still saves a file (so there's an on-disk artifact + path the
brain can mention, and future non-Canvas surfaces can use it).

```ts
import OpenAI from 'openai'; // default export, same as main/index.ts

let imagesClient: OpenAI | null = null;
function getImagesClient(): OpenAI {
  if (!imagesClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY missing in main process env');
    imagesClient = new OpenAI({ apiKey });
  }
  return imagesClient;
}

export interface GeneratedImageRef {
  ok: true;
  /** Inline data: URL — the form the Canvas can ACTUALLY render (CSP img-src data:). */
  image_url: string;
  /** Absolute path to the saved file on disk (~/.director/generated/…). */
  path: string;
  /** file:// URL of the saved file — NOT for the Canvas; for logs / future surfaces. */
  file_url: string;
  /** Echo of the resolved label so the brain can reuse it as the concept label. */
  label?: string;
}

export async function generateImageImpl(opts: {
  prompt: string;
  label?: string;
  size?: string;
}): Promise<GeneratedImageRef> {
  const client = getImagesClient();
  const size = (opts.size as ImageSize) ?? IMAGE_SIZE_DEFAULT;
  const resp = await client.images.generate({
    model: IMAGE_MODEL,            // gpt-image-1 (configurable)
    prompt: opts.prompt,
    size,
    n: 1,
    // dall-e-3 needs this to return base64; gpt-image-1 ignores it (always b64).
    response_format: 'b64_json',
  });
  const b64 = resp.data?.[0]?.b64_json;
  if (!b64) throw new Error('Images API returned no base64 image data');
  // Persist (reuses the existing helper — feed it the bare base64 body).
  const saved = saveGeneratedImage(b64, { label: opts.label, ext: 'png' });
  return {
    ok: true,
    image_url: `data:image/png;base64,${b64}`, // CSP-safe, renders in Moodboard
    path: saved.path,
    file_url: saved.fileUrl,
    label: opts.label,
  };
}
```

Implementation details:
- **`response_format: 'b64_json'`** is passed even for `gpt-image-1` (it ignores
  it harmlessly) so swapping to `dall-e-3` via `DIRECTOR_IMAGE_MODEL` Just Works.
- If a future `openai` version rejects `response_format` for `gpt-image-1`, wrap
  the param in a model check; for v4.104 it is accepted (param exists in
  `ImageGenerateParams`). Keep it for `dall-e-3` correctness.
- `ImageSize` is a local type alias of the four allowed values; coalesces to
  `1024x1024`.
- `saveGeneratedImage` is UNCHANGED — it already accepts a bare base64 body and
  writes a PNG to `~/.director/generated/<ts>-<slug>.png` (`agent-brain.ts:119`).
  We keep the file write for the artifact + path, but the **Canvas uses the
  `data:` URL**, never the path.

### A.3 Return shape → moodboard display

The brain's flow (now possible end-to-end with no TS-function call):

1. For each concept: call `generate_image({ prompt, label })` →
   `{ ok, image_url: "data:image/png;base64,…", path, file_url, label }`.
2. Collect the `image_url`s.
3. Call `show_canvas('moodboard', props_json = JSON.stringify({ title, concepts:
   [{ id, label, description, image_url }] }))` with the **`data:` URLs**.

`Moodboard.tsx` needs **no change** — it already does
`backgroundImage: url("${image}")` and `data:` is allowed by both `img-src` and
the existing `hasImage()` guard. (Optional cleanup, not required: fix the stale
doc-comment lines 14–18/35–40 that claim `file://` works — but leave the runtime
behavior alone.)

`show_canvas`'s tool description currently says "image_url = file:// paths"
(`agent-brain.ts:158,164`) — **update that wording to say `data:` URLs from
`generate_image`** (same file, allowed in FIX phase). The example JSON in the
`props_json` `.describe(...)` should use a `data:image/png;base64,…` stub, not a
`file:///…` path, so the brain copies the right form.

### A.4 Persona edit (delete the impossible instruction)

`BRAIN_INSTRUCTIONS` line ~299 currently says: *"use `imageGenerationTool` … SAVE
it with `saveGeneratedImage(data, { label })` … returns a `file://` URL, THEN show
them …"*. **Replace** with the real-tool instruction:

> For GENERATIVE concept art — mood, texture, hero imagery, brand looks judged by
> eye — call the `generate_image` tool once per concept (`{ prompt, label }`). It
> returns an `image_url` you can show directly. Collect each `image_url`, then call
> `show_canvas` once — component:'moodboard', props_json = JSON.stringify({ title,
> concepts: [{ id, label, description, image_url }] }). Generate every image FIRST,
> then show ONE moodboard with all concepts — never show an empty moodboard. Image
> generation is YOUR job (the voice layer can't do it and routes these to you).

No mention of `saveGeneratedImage`, no mention of `file://`, no claim that the
brain runs any TS function. The brain only calls TOOLS.

### A.5 Remove the hosted tool

In `getAgent()` (`agent-brain.ts:373–388`): drop `imageGenerationTool()` from the
`tools` array and the `imageGenerationTool` import (line 35); add `generateImageTool`.
`saveGeneratedImage` stays exported (still used by the executor + already unit-tested
via `_internals`). Add `generateImageImpl` to `_internals` for headless testing
(inject a fake client — see §A.6).

### A.6 Testing (headless, no network)

- Unit-test `generateImageImpl` with an injected fake `images.generate` returning a
  known `b64_json`; assert `image_url` starts with `data:image/png;base64,`, that a
  file landed under `GENERATED_DIR`, and that `file_url` is a `file://` of that path.
  (Inject via a small seam: allow `getImagesClient` to be overridden in tests, or
  pass an optional client arg to `generateImageImpl`.)
- Assert the tool's `execute` returns valid JSON for both success and the
  caught-error branch (`{ ok:false, error }`).
- Existing `saveGeneratedImage` tests remain green (unchanged behavior).

---

## B. Codex dispatch + working directory + worktree model

### B.1 Shared working-directory notion (the brain's roaming cwd)

Today dispatch resolves `targetRepo = resolveTargetRepo(homedir())`
(`tool-router.ts:243`), ignoring where the brain's shell actually roamed. We make
the brain's cwd the single source of truth for "where work happens".

- **Expose the brain's cwd.** `makeLocalShell` (`agent-brain.ts:263`) currently
  hides `currentCwd` in a closure. Refactor so the module retains a reference to
  the live cwd and exports a getter:

  ```ts
  let brainShellCwd = startDir();
  function makeLocalShell(startCwd: string): Shell {
    brainShellCwd = startCwd;
    return { async run(action) { /* … */ brainShellCwd = res.cwd; /* … */ } };
  }
  export function getBrainCwd(): string { return brainShellCwd; }
  ```

  (Keep the per-command sentinel logic; just lift the variable so the getter
  reads the latest value. The getter is the shared "working directory" the
  realtime layer and the dispatch tool both consult.)

- **`resolveTargetRepo` becomes cwd-first.** New precedence (update
  `agent-tools.ts:198`): **`explicit arg (from the brain's dispatch tool) → brain's
  current cwd (getBrainCwd) → DIRECTOR_PROJECT_ROOT → $HOME`.** The realtime
  `dispatch_agent_mock` path (which has no explicit cwd) resolves to
  `getBrainCwd()` so "make a folder and spin up the team there" — set up by the
  brain's shell — and a voice "send Maya in" land in the SAME directory.

  To avoid `agent-tools.ts` importing `agent-brain` (and dragging electron-free
  test isolation around), inject the cwd resolver: `resolveTargetRepo(opts: {
  explicit?: string; brainCwd?: string; home: string })`. The tool-router passes
  `brainCwd: getBrainCwd()`; tests pass a literal. (agent-tools stays
  Electron-free and unit-testable.)

### B.2 The brain's `dispatch_agent` tool (real executor → codex-pool)

The brain needs to dispatch agents itself so "mkdir a folder, git init it, then
spin up the team there" is one flow it controls. Add a real function tool in
`agent-brain.ts`:

```ts
const dispatchAgentBrainTool = tool({
  name: 'dispatch_agent',
  description:
    "Dispatch a real Codex coding sub-agent INTO your current working directory. " +
    "Use after you've made/entered the project folder in your shell (mkdir -p x && " +
    "cd x; git init if new). Pick the agent by role: maya=frontend, jin=backend, " +
    "cleo=data, wren=design. The agent works in your cwd, commits as it goes, and " +
    "its progress streams to the Hive. Returns the agent id + branch.",
  parameters: z.object({
    agent: z.enum(['maya', 'jin', 'cleo', 'wren']),
    task: z.string().describe('A complete, self-contained task brief for the agent.'),
    use_worktree: z
      .boolean()
      .nullable()
      .describe('Default false = work in the shared cwd. true = isolated worktree (auto-merges on finish).'),
  }),
  async execute({ agent, task, use_worktree }) {
    const r = await dispatchFromBrain({ agent, task, useWorktree: use_worktree ?? false });
    return JSON.stringify(r);
  },
});
```

The executor `dispatchFromBrain` lives in a **new main file owned by this wave**
(`main/brain-dispatch.ts`) so it can import `codex-pool` (Electron) without making
`agent-brain` pull Electron eagerly (lazy `await import('./codex-pool.js')`, same
trick `show_canvas` uses for `canvas.js`). It:

1. Resolves `targetRepo = getBrainCwd()`.
2. Ensures the dir is dispatch-ready via `ensureDispatchTarget(targetRepo, { worktree })`
   (§B.3) — `git init` if needed.
3. Resolves identity from the same `maya/jin/cleo/wren` table the router uses
   (re-export `resolveIdentity` from `tool-router` is shared wiring — instead the
   brain-dispatch file holds its own tiny identity map, or imports a shared one;
   list under wiring_required if a shared table is wanted).
4. Calls `dispatchAgentReal(args, getSessionId() ?? <fallback>, dispatchAgent)` —
   the SAME driver the realtime path uses — passing `targetRepo`, and `batchId`
   when `use_worktree` is true (so the auto-merge fan-in fires; §B.4).
5. Returns `{ ok, agent_id, branch, worktree, mode: 'shared' | 'worktree' }`.

**Both dispatch entry points share one target resolution and one driver.** The
realtime `dispatch_agent_mock` (router) and the brain `dispatch_agent` both call
`dispatchAgentReal` → `dispatchAgent` (codex-pool) → `dispatchAgentCore`. The only
difference is who supplies `targetRepo` (brain cwd) and whether `use_worktree`/
`batchId` is set.

> NOTE (trust-boundary): `task` is brain-authored free text passed to a real
> Codex subprocess with `sandboxMode: 'workspace-write'`. That is the existing,
> intended trust model (the brain is the user's manager on the user's machine).
> The `dispatchFromBrain` executor MUST NOT shell-interpolate `task`; it passes it
> as a structured field to the SDK (which `dispatchAgentCore` already does via
> `thread.runStreamed(req.task, …)`). No new injection surface is added.

### B.3 No hard git-repo requirement — `ensureDispatchTarget` + conditional worktree

Replace the unconditional worktree + `skipGitRepoCheck:false` with a target-prep
step and a **mode switch** in `dispatchAgentCore`.

**New helper** `ensureDispatchTarget(dir, { worktree })` (in `codex-worktree.ts`,
which already owns git plumbing). Logic:

```
mkdir -p dir
isRepo = `git -C dir rev-parse --is-inside-work-tree` exits 0
if (!isRepo) {
  git -C dir init
  git -C dir add -A            # stage whatever the brain created
  git -C dir commit -m "Director: initial commit" --allow-empty
}                              # → dir is now a repo with at least one commit
if (worktree && !hasCommits(dir)) git -C dir commit --allow-empty -m "Director: base"
return { isRepo: true, hadToInit: !isRepo }
```

- A fresh dir gets `git init` + an initial commit so `git worktree add <base>` (if
  worktree mode) has a base ref, and so shared-mode agents have a clean baseline to
  diff/commit against. **Never fail with "must be a git repo".**
- `baseBranch` default stays `main`; if the freshly-init'd repo's default branch is
  `master` (old git) or unborn, resolve the actual current branch via
  `git -C dir rev-parse --abbrev-ref HEAD` and use that as the base. Do not assume
  `main` exists. (`createWorktree` must take the resolved base, not a hardcoded one.)

**`dispatchAgentCore` mode switch** (`codex-pool-core.ts`): add an optional
`useWorktree?: boolean` to `DispatchAgentRequest` (append-only field; default
`false`).

```ts
// before starting the thread:
await ensureDispatchTarget(req.targetRepo, { worktree: req.useWorktree ?? false });

let workingDirectory: string;
let handle: WorktreeHandle | null = null;
let branch: string;
if (req.useWorktree) {
  handle = await createWorktree({ sessionId, agentId, targetRepo, baseBranch });
  workingDirectory = handle.path;
  branch = handle.branch;
} else {
  // SHARED MODE (default): agents work directly in the target dir.
  workingDirectory = req.targetRepo;
  branch = await currentBranchOf(req.targetRepo); // for the agent_started payload
}

const thread = getCodex().startThread({
  workingDirectory,
  sandboxMode: 'workspace-write',
  approvalPolicy: 'never',
  skipGitRepoCheck: true, // ensureDispatchTarget guarantees a repo; never block on it
});
```

- `skipGitRepoCheck: true` is now safe **because `ensureDispatchTarget` guarantees a
  repo first** (we no longer rely on the SDK's pre-check to enforce it). Setting it
  `true` means a transient probe race can't reject the dispatch.
- **Shared mode is the default** (user explicitly said this is fine). `AGENTS.md` is
  still written into `workingDirectory`; in shared mode that's the target dir itself
  (one file at the repo root, same as a normal Codex run).
- **Cleanup is worktree-only.** The `finally{}` block's `record.handle.cleanup()`
  (`codex-pool-core.ts:393–400`) only runs when `handle` is non-null. In shared mode
  there's nothing to tear down (the work stays in the user's dir — that's the point).
  Guard every `handle.*` access with a null check; `DispatchAck.worktree` becomes the
  working directory (worktree path in worktree mode, target dir in shared mode) and
  `branch` is the resolved branch.

### B.4 Worktrees are opt-in; when used, auto-merge on completion

- **Default = shared dir** (§B.3). No fan-in needed; commits land directly on the
  target branch as the agent works.
- **Worktree mode (opt-in)** keeps the existing isolation + auto-merge:
  - The brain sets `use_worktree: true` (or a future realtime tool flag). For
    worktree agents the dispatcher MUST set a `batchId` (even a single-agent batch),
    because the auto-merge fan-in is driven by the synthetic `batch_completed`
    event, which only fires for batched agents (`codex-pool-core.ts`
    `maybeEmitBatchCompleted`). A natural batchId: `brain-<sessionId>-<ts>` for a
    one-shot, or one shared id when the brain spins up a team together.
  - On the last agent's `agent_finished`, `batch_completed` synthesizes →
    `codex-pool.ts onBatchCompleted` → `mergeFanIn({ autoMergeIfNonOverlapping:
    true, integrationBranch: <base>, repoRoot: targetRepo })` →
    `releaseBatchWorktrees`. **This path already exists and works** (§finding 6);
    we only have to ensure worktree-mode dispatches carry a `batchId` and that
    `integrationBranch` is the resolved base branch of `targetRepo` (not a hardcoded
    `main` — pass `repoRoot` so `mergeFanIn` defaults `integrationBranch` to the
    repo's actual `HEAD` branch, per `worktree-merger.ts:247–248`).
  - **"Commit frequently" for ephemeral worktree agents:** add a line to the
    worktree-mode `AGENTS.md` boundaries (the `buildAgentsMd` template,
    `codex-pool-core.ts:97`): *"You are on a short-lived branch that auto-merges
    when you finish — commit each logical change immediately so nothing is lost at
    fan-in."* (Shared-mode AGENTS.md keeps the standard atomic-commit line.) This is
    a template tweak the FIX-phase owner makes inside `codex-pool-core.ts` (its own
    file).

### B.5 The cwd / dispatch / worktree contract (summary)

| Concern | Contract |
| --- | --- |
| Where work happens | `getBrainCwd()` — the brain's persistent roaming shell cwd. Both the brain's `dispatch_agent` and the realtime `dispatch_agent_mock` resolve here (then `DIRECTOR_PROJECT_ROOT`, then `$HOME`). |
| Brain sets up the dir | Brain uses its shell: `mkdir -p x && cd x` (and may `git init`). `getBrainCwd()` now points at `x`. |
| Non-repo target | `ensureDispatchTarget` runs `git init` + an initial commit. Never fails with "must be a git repo". |
| Default isolation | **Shared dir.** Agents run with `workingDirectory = targetRepo`; commits land on the target branch directly. No worktree, no fan-in. |
| Opt-in isolation | `use_worktree: true` → per-agent worktree on `director/<sessionId>/<agentId>`; dispatcher sets a `batchId`; auto-merge fan-in fires on completion via the existing `batch_completed` → `mergeFanIn` path; worktrees are ephemeral (`releaseBatchWorktrees`). |
| Base branch | Resolved from the target repo's actual current branch (not hardcoded `main`); a freshly-init'd repo uses whatever `git init` produced. |
| Shared driver | Both entry points call `dispatchAgentReal → dispatchAgent → dispatchAgentCore`. One resolver, one driver, one event stream. |

### B.6 Testing (headless)

- `ensureDispatchTarget`: temp dir (non-repo) → asserts it becomes a repo with ≥1
  commit; existing repo → no-op (HEAD unchanged). Pure git via `spawn`; no network.
- `dispatchAgentCore` shared mode: inject a fake `Codex` (the SDK is already
  injectable via the `getCodex` singleton — add a test seam) and assert
  `startThread` is called with `workingDirectory === targetRepo`,
  `skipGitRepoCheck: true`, and that NO worktree is created and the `finally{}`
  cleanup does not call git worktree remove.
- Worktree mode + single-agent batch: assert `batch_completed` synthesizes and (with
  a stubbed `mergeDriver`, via the existing `_setMergeDriverForTests`) that
  `onBatchCompleted` calls the driver with `integrationBranch`/`repoRoot` from the
  target. (Reuse the existing batch-tracking + merge tests as the harness.)
- `resolveTargetRepo` precedence unit test: explicit > brainCwd > env > home.

---

## C. Remove every "LLM calls a TS function" capability

Audit result (grep over `agent-brain.ts`): the **only** instruction telling the LLM
to call a TS function is the `saveGeneratedImage(...)` line in `BRAIN_INSTRUCTIONS`
(line ~299). It is deleted in §A.4. Everything else the persona references is a real
tool: `show_canvas` (tool), the Pencil MCP tools (tools), the `shellTool` (tool),
and now `generate_image` + `dispatch_agent` (tools). `renderCanvas` is mentioned
only in CODE COMMENTS (lines 137, 176) describing the `show_canvas` executor, not in
the persona — leave those. No other "call X yourself" phrasing exists. **After §A.4,
the brain's persona instructs it to use ONLY tools.**

---

## D. What the FIX wave creates/edits vs. what the INTEGRATE wave must wire

The FIX-phase owner of THIS spec may create/own these (no shared-wiring edits):
- `agent-brain.ts` — its own file: add `generateImageTool`, `generateImageImpl`,
  `dispatchAgentBrainTool`, `getBrainCwd`; swap the persona lines; drop
  `imageGenerationTool`; extend `_internals`.
- `main/brain-dispatch.ts` — NEW file: `dispatchFromBrain` executor (lazy-imports
  codex-pool).
- `codex-worktree.ts` — its own file: add `ensureDispatchTarget`, resolve base
  branch, export a `currentBranchOf` helper.
- `codex-pool-core.ts` — its own file: add `useWorktree` to `DispatchAgentRequest`
  (append-only field), the shared/worktree mode switch, the null-handle cleanup
  guard, `skipGitRepoCheck: true`, the worktree-mode AGENTS.md line.
- Tests next to each.

**INTEGRATE wave must wire** (shared dispatch/tool-enum/resolver surfaces — do NOT
edit these in the FIX phase; list here):
- `tool-router.ts handleDispatchAgentMock` — change `resolveTargetRepo(homedir())`
  to the new cwd-first resolver (`{ brainCwd: getBrainCwd(), home: homedir() }`).
  (Shared entry point.)
- `agent-tools.ts resolveTargetRepo` — new signature/precedence (shared resolver).
- `agent-tools.ts dispatchAgentReal` request — thread `useWorktree`/`batchId` from
  the worktree path through to `dispatchAgent` (shared dispatch entry point).
- Confirm `getBrainCwd()` import wiring from `agent-brain` into the router (or via a
  tiny shared `working-dir.ts` if the brain import is undesirable in the router).
- (Optional, realtime) if voice should also pick worktree mode, add a flag to the
  realtime `dispatch_agent_mock` tool def (`shared/realtime.ts`) — a shared tool-enum
  edit, hence INTEGRATE-only.

These are the cross-cutting seams that, if skipped, would leave the new tools with
no production callers (the failure mode the Integrate wave exists to prevent).

---

## E. Acceptance (behavioral, end-to-end)

1. **Image:** brain receives "mock me three brand directions for X" → calls
   `generate_image` ×3 → calls `show_canvas('moodboard', …)` with three `data:`
   URLs → the Canvas window shows three filled tiles (no blank placeholders, no CSP
   console errors). Files exist under `~/.director/generated/`.
2. **Dispatch (shared, default):** brain `mkdir -p ~/dev/foo && cd ~/dev/foo` (new,
   non-repo) → `dispatch_agent('maya', task)` → no "must be a git repo" error; Maya
   runs in `~/dev/foo`, commits land on the dir's branch; the Hive shows real
   progress. No worktree created.
3. **Dispatch (worktree, opt-in):** `dispatch_agent('jin', task, use_worktree:true)`
   → isolated worktree; on finish, non-overlapping changes auto-merge into the base
   branch and the worktree is released.
4. **Typecheck + build + vitest green** (`pnpm --filter director typecheck` +
   `build` + `test`). No persona instruction tells the LLM to call a TS function.
