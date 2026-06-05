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
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  Agent,
  run,
  shellTool,
  setDefaultOpenAIKey,
  MCPServerStdio,
  type Shell,
  type ShellAction,
  type ShellResult,
} from '@openai/agents';

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
- To SHOW the user what you made, two paths: (1) take a screenshot of the Pencil design and surface that image on the Canvas, or (2) fetch/export the design's HTML via Pencil and show that. Prefer showing the artifact over describing it in words.
- If the Pencil tools aren't present in this session, say so plainly and fall back to writing the markup directly with the shell — don't pretend to have designed something you couldn't.

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

/** Test/diagnostic hook — exposed so the catastrophic guard is unit-testable. */
export const _internals = { isCatastrophic };
