/**
 * Agent brain — the Director's non-realtime deep intelligence.
 *
 * Replaces the reasoning-only gpt-5 Responses planner with a full agentic
 * brain built on the OpenAI Agents SDK (`@openai/agents`), running gpt-5.5.
 * Unlike the old planner (which could only *think* and had zero tools), this
 * agent has **full local system access** via the SDK's built-in `shellTool`
 * — it can read any file, grep, run `git`/`tsc`/tests, and investigate the
 * project like a developer before it reasons or delegates. `applyPatchTool`
 * lets it make edits directly when warranted.
 *
 * Architecture: Realtime (voice) → consult_director → THIS agent. The agent
 * investigates + reasons, then returns a 1–3 sentence summary the Realtime
 * layer narrates aloud. The Codex worker fleet remains the heavy-execution
 * tier (dispatched separately); this brain is the manager that understands
 * the whole system.
 *
 * Safety: full access is the point (it's the user's machine, same trust
 * model as the Codex agents), but `isCatastrophic()` hard-refuses a small
 * set of machine-wrecking commands so an autonomous loop can't `rm -rf /`
 * itself. We do NOT use needsApproval (there's no approval UI on the voice
 * path yet — it would stall the run); the denylist is the seatbelt.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  Agent,
  run,
  tool,
  shellTool,
  setDefaultOpenAIKey,
  MCPServerStdio,
  type Shell,
  type ShellAction,
  type ShellResult,
} from '@openai/agents';
import OpenAI from 'openai'; // default export, same as main/index.ts
import { z } from 'zod';
import type { CanvasComponentName, CanvasComponentProps } from '../shared/canvas-ipc.js';
// NOTE: `renderCanvas` lives in ./canvas.ts which imports `electron`. We import
// it LAZILY inside the tool's execute() (below) rather than at module top, so
// the agent-brain module graph doesn't eagerly pull electron — that keeps it
// importable from the headless vitest env (planner.test.ts → planner →
// agent-brain) without an electron shim.

// gpt-5.5 per product decision. Configurable so the exact API id is a
// one-line flip if it differs from this string.
const BRAIN_MODEL = process.env.DIRECTOR_BRAIN_MODEL || 'gpt-5.5';

// Where the brain's shell STARTS — NOT a jail. The shell's working directory
// persists across commands and roams wherever the user directs it (see
// makeLocalShell), exactly like a real terminal. DIRECTOR_PROJECT_ROOT is just
// an optional starting hint; the default is the user's home so the agent can
// be pointed at any existing project — or told to make a brand-new folder and
// build there — entirely by voice. The "project root" is a conversation, not a
// config.
function startDir(): string {
  return resolve(process.env.DIRECTOR_PROJECT_ROOT || homedir());
}

const DEFAULT_CMD_TIMEOUT_MS = 120_000;
// Sentinel used to recover the shell's working directory after each command so
// it persists (terminal-like). Unlikely to collide with real output.
const CWD_SENTINEL = '__DIRCWD__:';

// ─── Catastrophic-command seatbelt ──────────────────────────────────────
// Full access, minus the handful of commands that could brick the machine
// or the repo irrecoverably. Everything normal a dev does (git, tsc, rm of
// a project file, npm, etc.) passes.
const CATASTROPHIC = [
  /\brm\s+-rf?\s+(\/|~|\$HOME|\/\*)(\s|$)/, // rm -rf / or ~ or /*
  /\bmkfs\b/,
  /\bdd\b.*\bof=\/dev\//,
  /:\(\)\s*\{.*\}\s*;/, // fork bomb
  /\bshutdown\b|\breboot\b|\bhalt\b/,
  />\s*\/dev\/(sd|disk|nvme)/,
  /\bsudo\b\s+rm\b/,
];

function isCatastrophic(command: string): boolean {
  return CATASTROPHIC.some((re) => re.test(command));
}

// ─── Generated-image persistence (real `generate_image` tool, finish-spec §A) ─
// The brain can't call a TS function, so image generation is a real local
// FUNCTION tool (`generate_image`, below) whose executor runs in THIS main
// process: it calls the OpenAI Images API, hands the base64 bytes to THIS
// helper to persist on disk, and RETURNS a renderable image reference to the
// brain. The Canvas CSP (`img-src 'self' data: blob:` — canvas.html) blocks
// `file:`, so the brain shows the moodboard with the `data:` URL the executor
// returns, NOT the on-disk path. We still write the file for an on-disk
// artifact + a path the brain can mention (and future non-Canvas surfaces).
// It writes under homedir() — the same trust zone the shell already roams.
const GENERATED_DIR = join(homedir(), '.director', 'generated');

function slugify(s: string): string {
  return (
    (s || 'concept')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40) || 'concept'
  );
}

/**
 * Persist one generated image to `~/.director/generated/<ts>-<slug>.<ext>` and
 * return BOTH the absolute path and a `file://` URL of that path. `data` is the
 * raw base64 image body (a bare base64 string, or a full
 * `data:image/...;base64,…` data-URL — both are accepted). The `file://` URL is
 * for logs / on-disk reference ONLY; the Canvas CSP blocks `file:`, so the
 * `generate_image` executor returns the inline `data:` URL to the brain for
 * moodboard display (finish-spec §A.1 finding 1), never this path.
 *
 * Exported so the wiring is unit-testable headlessly and so the
 * `generateImageImpl` executor can call it directly.
 */
export function saveGeneratedImage(
  data: string,
  opts?: { label?: string; ext?: 'png' | 'webp' | 'jpeg' },
): { path: string; fileUrl: string } {
  // Tolerate a full data-URL: strip the `data:<mime>;base64,` prefix.
  const m = /^data:(image\/[a-z+]+);base64,(.*)$/i.exec(data.trim());
  const base64 = m ? m[2]! : data.trim();
  const ext =
    opts?.ext ?? (m ? (m[1]!.split('/')[1] ?? 'png').replace('jpeg', 'jpeg') : 'png');
  mkdirSync(GENERATED_DIR, { recursive: true });
  const file = `${Date.now()}-${slugify(opts?.label ?? '')}.${ext}`;
  const abs = join(GENERATED_DIR, file);
  writeFileSync(abs, Buffer.from(base64, 'base64'));
  return { path: abs, fileUrl: pathToFileURL(abs).href };
}

// ─── generate_image — real local image-generation tool (finish-spec §A) ──
// A REAL function tool (not the hosted imageGenerationTool, which returned
// bytes nothing captured and whose persona told the LLM to call a TS function
// it cannot call). The executor runs here in the main process: OpenAI Images
// API → base64 → saveGeneratedImage() → return a CSP-safe `data:` URL the
// brain shows on a moodboard. gpt-image-1 always returns base64; dall-e-3
// (the DIRECTOR_IMAGE_MODEL fallback) needs response_format:'b64_json'.
const IMAGE_MODEL = process.env.DIRECTOR_IMAGE_MODEL || 'gpt-image-1';
const IMAGE_SIZE_DEFAULT = '1024x1024';

/** The image sizes we expose to the brain (a safe subset of the SDK's union). */
type ImageSize = '1024x1024' | '1536x1024' | '1024x1536' | 'auto';

// Lazily-constructed Images client. A test seam (`_setImagesClientForTests`)
// lets headless unit tests inject a fake so no network/key is needed.
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

/**
 * Generate ONE image via the OpenAI Images API, persist it, and return a
 * CSP-safe `data:` URL (plus the on-disk path/file:// for reference). Runs in
 * the main process. The optional `client` arg is a test seam — production
 * callers omit it and get the lazily-built singleton.
 */
export async function generateImageImpl(
  opts: { prompt: string; label?: string; size?: string },
  client: OpenAI = getImagesClient(),
): Promise<GeneratedImageRef> {
  const size = (opts.size as ImageSize | undefined) ?? IMAGE_SIZE_DEFAULT;
  const resp = await client.images.generate({
    model: IMAGE_MODEL, // gpt-image-1 (configurable via DIRECTOR_IMAGE_MODEL)
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

const generateImageTool = tool({
  name: 'generate_image',
  description:
    'Generate ONE piece of concept art from a text prompt (mood, texture, hero ' +
    'imagery, a brand look). Returns a renderable image_url (an inline data: URL) ' +
    'plus a saved file path. Call this once per concept, collect the image_urls, ' +
    "then call show_canvas('moodboard', …) with all of them. This is how you make " +
    'generative imagery — the voice layer cannot, and routes these requests to you.',
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

// ─── show_canvas — the Brain's bridge to the visual Canvas ───────────────
// The Brain runs in the MAIN process, so it can drive the Canvas window
// directly via renderCanvas() — no IPC round-trip. This is what makes the
// Brain's work VISIBLE: a generated moodboard (image_url = the `data:` URLs
// returned by the generate_image tool), a gantt plan, a code_preview, a
// diagram, an html layout. Without it, image generation produced files nothing
// ever displayed (the foreground would open an empty moodboard). Props come as
// a JSON string so the tool schema stays simple + strict-safe; we parse + forward.
const CANVAS_COMPONENTS = [
  'moodboard',
  'options_picker',
  'code_preview',
  'diagram',
  'gantt',
  'html',
  'artifact_preview',
  'form',
  'agent_pod',
] as const;

const showCanvasTool = tool({
  name: 'show_canvas',
  description:
    "Display a component on the user's Canvas (the big visual surface). This is how your work becomes VISIBLE — prefer showing over describing. Use it for a generated moodboard (concepts whose image_url is a data: URL returned by the generate_image tool), a gantt plan, code_preview, a diagram, or an html layout. Never describe a moodboard in words when you can show it.",
  parameters: z.object({
    component: z.enum(CANVAS_COMPONENTS),
    props_json: z
      .string()
      .describe(
        'The component props as a JSON string. moodboard example: {"title":"Ergon landing","concepts":[{"id":"a","label":"Calm","description":"…","image_url":"data:image/png;base64,iVBORw0KGgo…"}]} (use the data: URLs returned by generate_image).',
      ),
  }),
  async execute({ component, props_json }) {
    let props: CanvasComponentProps;
    try {
      props = JSON.parse(props_json) as CanvasComponentProps;
    } catch {
      return 'props_json was not valid JSON — pass a JSON-stringified props object.';
    }
    try {
      const { renderCanvas } = await import('./canvas.js');
      renderCanvas({
        component: component as CanvasComponentName,
        props,
        component_id: `brain-${component}-${Date.now()}`,
      });
      return `Shown ${component} on the Canvas.`;
    } catch (err) {
      return `Failed to show ${component}: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ─── Local shell executor (full system access) ──────────────────────────

type ExecResult = {
  stdout: string;
  stderr: string;
  outcome: { type: 'exit'; exitCode: number | null } | { type: 'timeout' };
  /** The shell's working directory AFTER the command (persisted to the next). */
  cwd: string;
};

function execOne(command: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
  if (isCatastrophic(command)) {
    console.warn(`[agent-brain] REFUSED catastrophic command: ${command}`);
    return Promise.resolve({
      stdout: '',
      stderr: `Refused: "${command}" matches a catastrophic-command guard and was not executed.`,
      outcome: { type: 'exit', exitCode: 1 },
      cwd,
    });
  }
  console.log(`[agent-brain] (${cwd}) $ ${command}`);
  // Persistent-terminal semantics: cd into the current dir, run the command in
  // the SAME shell (so any `cd` the agent issues persists), then print the
  // resulting $PWD on a sentinel line we parse + strip. This is what lets the
  // agent roam anywhere / `mkdir -p new && cd new` and stay there across calls.
  const q = cwd.replace(/'/g, `'\\''`);
  const wrapped = `cd '${q}' 2>/dev/null; ${command}\n__rc=$?; printf '\\n${CWD_SENTINEL}%s\\n' "$PWD"; exit $__rc`;
  return new Promise((resolveP) => {
    // Login shell so the agent gets the user's PATH (node, git, pnpm, etc.).
    const child = spawn('/bin/zsh', ['-lc', wrapped]);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveP({
        stdout,
        stderr: stderr + `\n[spawn error] ${err instanceof Error ? err.message : String(err)}`,
        outcome: { type: 'exit', exitCode: 1 },
        cwd,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Recover the post-command working directory from the sentinel line and
      // strip it out of what the model sees.
      let newCwd = cwd;
      const idx = stdout.lastIndexOf(CWD_SENTINEL);
      if (idx !== -1) {
        const after = stdout.slice(idx + CWD_SENTINEL.length);
        const nl = after.indexOf('\n');
        const parsed = (nl === -1 ? after : after.slice(0, nl)).trim();
        if (parsed) newCwd = parsed;
        stdout = stdout.slice(0, idx).replace(/\n$/, '');
      }
      resolveP({
        stdout,
        stderr,
        outcome: timedOut ? { type: 'timeout' } : { type: 'exit', exitCode: code },
        cwd: newCwd,
      });
    });
  });
}

function makeLocalShell(startCwd: string): Shell {
  // The working directory PERSISTS across commands AND across consults — the
  // brain has one long-lived terminal session. Directing it ("work in ~/dev/x",
  // "make a new folder") moves this cwd and it stays there.
  let currentCwd = startCwd;
  return {
    async run(action: ShellAction): Promise<ShellResult> {
      const timeoutMs = action.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;
      const output = [];
      for (const command of action.commands) {
        const res = await execOne(command, currentCwd, timeoutMs);
        currentCwd = res.cwd;
        output.push({ stdout: res.stdout, stderr: res.stderr, outcome: res.outcome });
      }
      return { output };
    },
  };
}

// ─── Agent persona ──────────────────────────────────────────────────────

const BRAIN_INSTRUCTIONS = `You are the Director's deep brain — the manager's chair behind a calm voice orchestrator. You have FULL access to the user's machine through a shell tool: read any file, grep, run git / tsc / tests, inspect the project. Use it.

# Working directory — you have a PERSISTENT, ROAMING terminal
- Your shell keeps its working directory across commands, like a real terminal session. You start in a default directory, but you are NOT confined to it.
- When the user directs you to work somewhere — "work in ~/dev/foo", "look at my other repo", "make a new folder for this and build it there" — go there: \`cd\` into it (\`mkdir -p <dir> && cd <dir>\` for a new one) and stay. Every later command runs from wherever you last moved to.
- Do NOT assume a fixed "project". If it's ambiguous where to work, ask, or use the directory the user named. The working location is a conversation, not a config.

# How you work
- INVESTIGATE before you answer. Don't guess about the codebase — look. Run the commands a senior engineer would: list the tree, read the relevant files, check git status/log, run a typecheck or test when it informs the answer.
- Be efficient. Batch related shell commands. Don't re-read what you've already seen.
- You are the planner/orchestrator, not a chatbot. For execution-heavy work you'd normally hand off to the Codex worker fleet (Maya frontend, Jin backend, Cleo data, Wren design) — describe the breakdown; the system dispatches them.

# Visual & frontend design — use Pencil
- For ANY visual or frontend design work — a landing page, a marketing section, a widget, a UI component, a layout — use the Pencil design tools (the \`pencil\` MCP, when available). Design it there first; don't hand-write speculative HTML/CSS when you can compose it visually.
- To SHOW the user anything, call the \`show_canvas\` tool (component + props_json). It drives the Canvas directly. Prefer showing the artifact over describing it. For a Pencil design: screenshot/export it, then show the image (moodboard) or its HTML (component:'html').
- For GENERATIVE concept art — mood, texture, hero imagery, brand looks judged by eye — call the \`generate_image\` tool once per concept (\`{ prompt, label }\`). It returns an \`image_url\` you can show directly. Collect each \`image_url\`, then call \`show_canvas\` once — component:'moodboard', props_json = JSON.stringify({ title, concepts: [{ id, label, description, image_url }] }). Generate every image FIRST, then show ONE moodboard with all concepts — never show an empty moodboard. Image generation is YOUR job (the voice layer can't do it and routes these to you).
- If the Pencil tools aren't present in this session, say so plainly and fall back to writing the markup directly with the shell — don't pretend to have designed something you couldn't.

# When to do it yourself vs hand to Codex
- DO IT YOURSELF (you have a full shell + Pencil + image-gen): investigate the codebase, run git / tsc / tests, do online research, make LIGHT / SURGICAL edits, run quick experiments, design visuals in Pencil. You resolve in seconds-to-minutes — that's your lane. Investigate before you answer; don't guess.
- HAND TO THE CODEX FLEET the heavy, long-running, multi-file execution — building a whole feature, generating many files, a deep refactor, work that parallelizes across Maya (frontend) / Jin (backend) / Cleo (data) / Wren (design). Describe the breakdown (who does what); the system dispatches them. Don't hand-build for 30 minutes what the fleet should build; don't dispatch the fleet for a one-file fix you can make now.

# Showing plans and progress
- When you break work into steps or a plan, SHOW it as a gantt via \`show_canvas\` — component:'gantt', props_json = JSON.stringify({ title, tasks: [{ id, label, owner, status }] }) — and re-show it with updated statuses as work advances (same task ids; statuses move planned → running → done). Never read a multi-step plan aloud; show it.

# Output
- Your FINAL message is narrated aloud by the voice layer, so make it a tight 1–3 sentence summary in plain spoken English. No code blocks, no file dumps, no markdown — just what you found / decided / recommend.
- If you took an action (edited a file, ran a fix), say so in one clause.

# Style
- Terse, concrete, no filler. Use real names (files, agents). Never narrate your tool calls ("let me check…") — just do the work and report the conclusion.`;

// ─── Singleton agent ────────────────────────────────────────────────────

let cachedAgent: Agent | null = null;
let keySet = false;

// ─── Pencil MCP (visual / frontend design) ───────────────────────────────
// The brain gets Pencil's design tools so it can build landing pages, widgets,
// and components visually, then screenshot or export the result to show on the
// Canvas. Connected best-effort + lazily — if Pencil.app isn't installed or
// running, the brain simply runs without it (shell-only); it never blocks the
// consult path.
let pencil: MCPServerStdio | null = null;
let pencilTried = false;

async function getPencilServer(): Promise<MCPServerStdio | null> {
  if (pencilTried) return pencil;
  pencilTried = true;
  try {
    const server = new MCPServerStdio({
      name: 'pencil',
      command:
        '/Applications/Pencil.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64',
      args: ['--app', 'desktop'],
      // Inherit the parent env (the user's MCP config specifies no EXTRA vars);
      // an empty env would strip HOME/PATH and break the launcher.
      env: { ...process.env } as Record<string, string>,
      cacheToolsList: true,
    });
    await server.connect();
    pencil = server;
    console.log('[agent-brain] pencil MCP connected');
  } catch (err) {
    console.warn(
      '[agent-brain] pencil MCP unavailable — continuing without it (is Pencil.app installed?)',
      err,
    );
    pencil = null;
  }
  return pencil;
}

async function getAgent(): Promise<Agent> {
  if (!keySet) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      setDefaultOpenAIKey(apiKey);
      keySet = true;
    }
  }
  if (cachedAgent) return cachedAgent;
  const cwd = startDir();
  const pencilServer = await getPencilServer();
  cachedAgent = new Agent({
    name: 'Director Brain',
    model: BRAIN_MODEL,
    modelSettings: { reasoning: { effort: 'high' } },
    instructions: BRAIN_INSTRUCTIONS,
    tools: [
      shellTool({
        shell: makeLocalShell(cwd),
        needsApproval: false, // seatbelt is the denylist; no approval UI yet
      }),
      // Real local image-generation tool (finish-spec §A). Executor runs in
      // this main process: OpenAI Images API → base64 → saveGeneratedImage →
      // returns a CSP-safe `data:` URL the brain shows on a moodboard. Replaces
      // the old hosted imageGenerationTool (whose bytes nothing captured and
      // whose persona told the LLM to call a TS function it cannot call).
      // Structured layout/design still prefers Pencil (per the persona).
      generateImageTool,
      // The bridge that makes the Brain's work visible (moodboards, gantt,
      // code, diagrams) by driving the Canvas window directly.
      showCanvasTool,
    ],
    mcpServers: pencilServer ? [pencilServer] : [],
  });
  console.log(
    `[agent-brain] initialized — model=${BRAIN_MODEL} cwd=${cwd} pencil=${pencilServer ? 'on' : 'off'}`,
  );
  return cachedAgent;
}

export interface AgentBrainResult {
  summary: string;
  decisions: string[];
  full_text: string;
}

/**
 * Run the agent brain against a prompt. Returns a voice-narratable summary.
 * Mirrors the planner's `ConsultResult` shape so it drops into the existing
 * `consult_director` path.
 */
export async function runAgentBrain(prompt: string): Promise<AgentBrainResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('[agent-brain] OPENAI_API_KEY missing in main process env');
  }
  const agent = await getAgent();
  const result = await run(agent, prompt, { maxTurns: 40 });
  const text =
    typeof result.finalOutput === 'string'
      ? result.finalOutput
      : String(result.finalOutput ?? '');
  const summary = text.trim();
  return { summary, decisions: [], full_text: summary };
}

/**
 * Test/diagnostic hook — exposed so the catastrophic guard, image-save, and the
 * `generate_image` executor + tool are unit-testable headlessly. `generateImageTool`
 * is the live tool object (tests call its `.invoke`/`execute` with a fake client
 * injected via `_setImagesClientForTests`); `_setImagesClientForTests(null)` resets
 * back to the lazy production singleton.
 */
export const _internals = {
  isCatastrophic,
  saveGeneratedImage,
  GENERATED_DIR,
  generateImageImpl,
  generateImageTool,
  IMAGE_MODEL,
  _setImagesClientForTests(client: OpenAI | null) {
    imagesClient = client;
  },
};
