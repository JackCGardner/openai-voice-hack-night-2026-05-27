/**
 * Unit tests for `ensureDispatchTarget` + `currentBranchOf`
 * (finish-spec §B.3 / §B.6). Headless — real git via `spawn` in mkdtemp temp
 * dirs, no network, no Codex SDK.
 *
 * Covers:
 *   - a NON-repo target → gets `git init` + ≥1 commit (`hadToInit: true`);
 *     never throws "must be a git repo".
 *   - an EXISTING repo with commits → no-op (HEAD unchanged, `hadToInit:false`).
 *   - worktree mode on an init'd-but-uncommitted repo → guarantees a base ref.
 *   - `currentBranchOf` resolves the actual branch (not a hardcoded `main`).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDispatchTarget, currentBranchOf } from './codex-worktree.js';

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, args: string[]): { code: number; out: string } {
  const res = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
  });
  return { code: res.status ?? -1, out: (res.stdout ?? '').trim() };
}

function headSha(cwd: string): string | null {
  const r = git(cwd, ['rev-parse', 'HEAD']);
  return r.code === 0 ? r.out : null;
}

const tmpDirs: string[] = [];
async function mkTmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

describe('ensureDispatchTarget', () => {
  it('git-inits a non-repo target and gives it ≥1 commit (never rejects)', async () => {
    // A bare temp dir that the "brain" just mkdir'd — NOT a git repo.
    const dir = await mkTmp('director-ensure-nonrepo-');
    // Sanity: it is not a repo yet.
    expect(git(dir, ['rev-parse', '--is-inside-work-tree']).code).not.toBe(0);

    const res = await ensureDispatchTarget(dir);

    expect(res.isRepo).toBe(true);
    expect(res.hadToInit).toBe(true);
    // It is now a repo with a resolvable HEAD commit.
    expect(git(dir, ['rev-parse', '--is-inside-work-tree']).out).toBe('true');
    expect(headSha(dir)).toBeTruthy();
    // The resolved branch matches currentBranchOf (whatever `git init` chose).
    expect(res.branch).toBe(await currentBranchOf(dir));
  });

  it('stages pre-existing files the brain created into the initial commit', async () => {
    const dir = await mkTmp('director-ensure-files-');
    await fs.writeFile(join(dir, 'index.html'), '<h1>hi</h1>', 'utf8');

    await ensureDispatchTarget(dir);

    // The file the brain dropped is committed (clean working tree afterward).
    const status = git(dir, ['status', '--porcelain']);
    expect(status.out).toBe('');
    const tracked = git(dir, ['ls-files']);
    expect(tracked.out.split('\n')).toContain('index.html');
  });

  it('is a no-op on an existing repo with commits (HEAD unchanged)', async () => {
    const dir = await mkTmp('director-ensure-repo-');
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    await fs.writeFile(join(dir, 'README.md'), '# fixture\n', 'utf8');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'base']);
    const before = headSha(dir);

    const res = await ensureDispatchTarget(dir);

    expect(res.hadToInit).toBe(false);
    expect(res.isRepo).toBe(true);
    expect(res.branch).toBe('main');
    // No new commit was created.
    expect(headSha(dir)).toBe(before);
  });

  it('worktree mode guarantees a base ref on an init-only (unborn HEAD) repo', async () => {
    const dir = await mkTmp('director-ensure-unborn-');
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    // No commit yet → unborn HEAD.
    expect(headSha(dir)).toBeNull();

    const res = await ensureDispatchTarget(dir, { worktree: true });

    // Now there's a base ref so `git worktree add <base>` would succeed.
    expect(res.isRepo).toBe(true);
    expect(res.hadToInit).toBe(false); // it WAS already a repo
    expect(headSha(dir)).toBeTruthy();
  });
});

describe('currentBranchOf', () => {
  it('returns the repo actual current branch, not a hardcoded main', async () => {
    const dir = await mkTmp('director-branch-');
    git(dir, ['init', '-b', 'trunk']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    await fs.writeFile(join(dir, 'a.txt'), 'a', 'utf8');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'base']);

    expect(await currentBranchOf(dir)).toBe('trunk');
  });
});
