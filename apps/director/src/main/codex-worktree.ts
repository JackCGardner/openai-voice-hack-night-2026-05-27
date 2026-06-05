/**
 * Codex worktree manager — creates and tears down per-agent git worktrees
 * under ~/.director/sessions/<session-id>/agents/<agent-id>/worktree/.
 *
 * Each worktree is a checkout of the user's target repo. The agent works
 * in that worktree, so commits, edits, and file changes are isolated until
 * a fan-in merge at the end of the session. Branch names follow
 * `director/<sessionId>/<agentId>` so a leaked worktree is identifiable
 * and trivially diffable from `main` if the user wants to inspect it.
 *
 * See docs/research/codex-for-everything.md § 4 for the rationale (4
 * concurrent worktrees is the practical ceiling per the OpenAI docs).
 */

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface WorktreeOpts {
  /** Stable identifier for the Director session (one user dialog). */
  sessionId: string;
  /** Stable identifier for the agent (maya / jin / cleo / wren / …). */
  agentId: string;
  /** Absolute path to the user's target repo (their current project / roaming cwd). */
  targetRepo: string;
  /** Defaults to `main`. */
  baseBranch?: string;
}

export interface WorktreeHandle {
  /** Absolute path to the worktree checkout. */
  path: string;
  /** Branch name the worktree is anchored on. */
  branch: string;
  /** Tear down the worktree + its branch. Safe to call multiple times. */
  cleanup: () => Promise<void>;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) =>
      resolve({ stdout, stderr, code: code ?? -1 }),
    );
    proc.on('error', (err) =>
      resolve({ stdout, stderr: `${stderr}${err.message}`, code: -1 }),
    );
  });
}

function sessionRoot(sessionId: string): string {
  return join(homedir(), '.director', 'sessions', sessionId);
}

function agentRoot(sessionId: string, agentId: string): string {
  return join(sessionRoot(sessionId), 'agents', agentId);
}

// ─── Target-dir preparation (git-init-if-needed) ────────────────────────
//
// finish-spec §B.3. Dispatch must NOT hard-require a pre-existing git repo.
// The brain may `mkdir -p x && cd x` a brand-new folder and then dispatch a
// Codex agent into it. `ensureDispatchTarget` makes that dir dispatch-ready:
// it creates the dir, `git init`s it if it isn't already a repo (staging +
// committing whatever the brain put there so there's a base ref), and — for
// worktree mode — guarantees at least one commit so `git worktree add <base>`
// has something to branch from. It NEVER throws "must be a git repo"; a
// non-repo target is initialized, not rejected.

export interface EnsureDispatchTargetResult {
  /** Always true on success — the dir is a repo with ≥1 commit afterwards. */
  isRepo: true;
  /** Whether we had to `git init` (true) or it was already a repo (false). */
  hadToInit: boolean;
  /** The repo's current branch after preparation (the dispatch base branch). */
  branch: string;
}

/** True if `dir` is inside a git work tree (exit 0 from rev-parse). */
async function isGitRepo(dir: string): Promise<boolean> {
  const r = await run('git', ['rev-parse', '--is-inside-work-tree'], dir);
  return r.code === 0 && r.stdout.trim() === 'true';
}

/** True if `dir`'s HEAD resolves to a commit (i.e. the repo has ≥1 commit). */
async function hasCommits(dir: string): Promise<boolean> {
  const r = await run('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], dir);
  return r.code === 0 && r.stdout.trim().length > 0;
}

/**
 * Resolve a repo's current branch name (`git rev-parse --abbrev-ref HEAD`).
 * On a freshly-init'd repo with no commits the symbolic ref still resolves
 * (e.g. `main` or `master`) so worktree/base-branch logic has a name to use.
 * Falls back to `main` only if git produces nothing parseable.
 */
export async function currentBranchOf(dir: string): Promise<string> {
  const r = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  const name = r.stdout.trim();
  if (r.code === 0 && name && name !== 'HEAD') return name;
  // Detached HEAD or unborn-but-unnamed: try the symbolic-ref short form.
  const sym = await run('git', ['symbolic-ref', '--short', 'HEAD'], dir);
  const symName = sym.stdout.trim();
  if (sym.code === 0 && symName) return symName;
  return 'main';
}

/**
 * Make `dir` dispatch-ready (finish-spec §B.3). Idempotent: an existing repo
 * with commits is left untouched (HEAD unchanged). A non-repo is `git init`'d
 * and gets an initial commit (staging anything already in the dir). In
 * worktree mode we additionally guarantee a base commit exists so
 * `git worktree add <base>` has a ref to branch from.
 *
 * Never rejects a non-repo — that's the whole point. Throws only on a genuine
 * git failure (e.g. git not installed), which the caller surfaces as a
 * dispatch error.
 */
export async function ensureDispatchTarget(
  dir: string,
  opts?: { worktree?: boolean },
): Promise<EnsureDispatchTargetResult> {
  await fs.mkdir(dir, { recursive: true });

  const alreadyRepo = await isGitRepo(dir);
  if (!alreadyRepo) {
    const init = await run('git', ['init'], dir);
    if (init.code !== 0) {
      throw new Error(
        `[codex-worktree] git init failed in ${dir} (${init.code}): ${init.stderr.trim()}`,
      );
    }
    // Stage whatever the brain already created in this folder, then commit so
    // there's a base ref. `--allow-empty` covers a truly empty new dir.
    await run('git', ['add', '-A'], dir);
    const commit = await run(
      'git',
      ['commit', '--allow-empty', '-m', 'Director: initial commit'],
      dir,
    );
    if (commit.code !== 0) {
      // A commit can fail if user.name/user.email are unset. Configure a
      // local identity (scoped to this repo only) and retry — we must not
      // leave the repo without a base ref or `git worktree add` will fail.
      await run('git', ['config', 'user.email', 'director@localhost'], dir);
      await run('git', ['config', 'user.name', 'Director'], dir);
      const retry = await run(
        'git',
        ['commit', '--allow-empty', '-m', 'Director: initial commit'],
        dir,
      );
      if (retry.code !== 0) {
        throw new Error(
          `[codex-worktree] initial commit failed in ${dir} (${retry.code}): ${retry.stderr.trim()}`,
        );
      }
    }
  } else if (opts?.worktree && !(await hasCommits(dir))) {
    // Existing repo with an unborn HEAD (init'd but never committed) + worktree
    // mode → give `git worktree add` a base ref.
    const commit = await run(
      'git',
      ['commit', '--allow-empty', '-m', 'Director: base'],
      dir,
    );
    if (commit.code !== 0) {
      await run('git', ['config', 'user.email', 'director@localhost'], dir);
      await run('git', ['config', 'user.name', 'Director'], dir);
      await run('git', ['commit', '--allow-empty', '-m', 'Director: base'], dir);
    }
  }

  const branch = await currentBranchOf(dir);
  return { isRepo: true, hadToInit: !alreadyRepo, branch };
}

/**
 * Create an isolated git worktree under
 * `~/.director/sessions/<sessionId>/agents/<agentId>/worktree/`.
 * Throws on git failure — caller is responsible for releasing any
 * acquired semaphore slot.
 *
 * NOTE: callers should `ensureDispatchTarget(targetRepo, { worktree: true })`
 * first so a fresh/empty dir has a base ref. `baseBranch` should be the repo's
 * RESOLVED current branch (via `currentBranchOf`), not a hardcoded `main` — a
 * freshly-init'd repo may be on `master` or a user default.
 */
export async function createWorktree(
  opts: WorktreeOpts,
): Promise<WorktreeHandle> {
  const baseBranch = opts.baseBranch ?? 'main';
  const root = agentRoot(opts.sessionId, opts.agentId);
  const worktreePath = join(root, 'worktree');
  const branch = `director/${opts.sessionId}/${opts.agentId}`;

  await fs.mkdir(root, { recursive: true });

  // If a stale worktree already lives here from a previous run, prune the
  // git metadata before re-adding. Prune is a no-op when nothing is stale.
  await run('git', ['worktree', 'prune'], opts.targetRepo);

  const result = await run(
    'git',
    ['worktree', 'add', '-B', branch, worktreePath, baseBranch],
    opts.targetRepo,
  );
  if (result.code !== 0) {
    throw new Error(
      `[codex-worktree] git worktree add failed (${result.code}): ${result.stderr.trim()}`,
    );
  }

  return {
    path: worktreePath,
    branch,
    cleanup: async () => {
      // `--force` so we can tear down even if the agent left dirty files.
      await run(
        'git',
        ['worktree', 'remove', '--force', worktreePath],
        opts.targetRepo,
      );
      // Best-effort: also delete the branch so we don't accumulate refs.
      // Failures are non-fatal (e.g., branch already gone, or the worktree
      // still references it because remove failed above).
      await run('git', ['branch', '-D', branch], opts.targetRepo);
    },
  };
}

/**
 * Diagnostic: list any worktree directories under a session root. Used by
 * future cleanup tooling to garbage-collect stale sessions.
 */
export async function listSessionWorktrees(
  sessionId: string,
): Promise<string[]> {
  try {
    const root = join(sessionRoot(sessionId), 'agents');
    const entries = await fs.readdir(root);
    return entries.map((agentId) => join(root, agentId, 'worktree'));
  } catch {
    return [];
  }
}
