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
import {
  Agent,
  run,
  shellTool,
  setDefaultOpenAIKey,
  type Shell,
  type ShellAction,
  type ShellResult,
} from '@openai/agents';

// gpt-5.5 per product decision. Configurable so the exact API id is a
// one-line flip if it differs from this string.
const BRAIN_MODEL = process.env.DIRECTOR_BRAIN_MODEL || 'gpt-5.5';

// The project the brain operates on. Defaults to the user's configured
// project root (DIRECTOR_PROJECT_ROOT) else the process cwd.
function projectRoot(): string {
  return resolve(process.env.DIRECTOR_PROJECT_ROOT || process.cwd());
}

const DEFAULT_CMD_TIMEOUT_MS = 120_000;

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

function execOne(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; outcome: { type: 'exit'; exitCode: number | null } | { type: 'timeout' } }> {
  if (isCatastrophic(command)) {
    console.warn(`[agent-brain] REFUSED catastrophic command: ${command}`);
    return Promise.resolve({
      stdout: '',
      stderr: `Refused: "${command}" matches a catastrophic-command guard and was not executed.`,
      outcome: { type: 'exit', exitCode: 1 },
    });
  }
  console.log(`[agent-brain] $ ${command}`);
  return new Promise((resolveP) => {
    // Login shell so the agent gets the user's PATH (node, git, pnpm, etc.).
    const child = spawn('/bin/zsh', ['-lc', command], { cwd });
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
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({
        stdout,
        stderr,
        outcome: timedOut ? { type: 'timeout' } : { type: 'exit', exitCode: code },
      });
    });
  });
}

function makeLocalShell(cwd: string): Shell {
  return {
    async run(action: ShellAction): Promise<ShellResult> {
      const timeoutMs = action.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;
      const output = [];
      for (const command of action.commands) {
        output.push(await execOne(command, cwd, timeoutMs));
      }
      return { output };
    },
  };
}

// ─── Agent persona ──────────────────────────────────────────────────────

const BRAIN_INSTRUCTIONS = `You are the Director's deep brain — the manager's chair behind a calm voice orchestrator. You have FULL access to the user's machine through a shell tool: read any file, grep, run git / tsc / tests, inspect the project. Use it.

# How you work
- INVESTIGATE before you answer. Don't guess about the codebase — look. Run the commands a senior engineer would: list the tree, read the relevant files, check git status/log, run a typecheck or test when it informs the answer.
- Be efficient. Batch related shell commands. Don't re-read what you've already seen.
- You are the planner/orchestrator, not a chatbot. For execution-heavy work you'd normally hand off to the Codex worker fleet (Maya frontend, Jin backend, Cleo data, Wren design) — describe the breakdown; the system dispatches them.

# Output
- Your FINAL message is narrated aloud by the voice layer, so make it a tight 1–3 sentence summary in plain spoken English. No code blocks, no file dumps, no markdown — just what you found / decided / recommend.
- If you took an action (edited a file, ran a fix), say so in one clause.

# Style
- Terse, concrete, no filler. Use real names (files, agents). Never narrate your tool calls ("let me check…") — just do the work and report the conclusion.`;

// ─── Singleton agent ────────────────────────────────────────────────────

let cachedAgent: Agent | null = null;
let keySet = false;

function getAgent(): Agent {
  if (!keySet) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      setDefaultOpenAIKey(apiKey);
      keySet = true;
    }
  }
  if (cachedAgent) return cachedAgent;
  const cwd = projectRoot();
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
  });
  console.log(`[agent-brain] initialized — model=${BRAIN_MODEL} cwd=${cwd}`);
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
  const agent = getAgent();
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
