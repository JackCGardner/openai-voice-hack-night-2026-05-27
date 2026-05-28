/**
 * Round-trip tests for the W3 P6.3 + P6.3b side-store additions:
 *
 *   - `writeStateSnapshot` debounces + `forceFlushSnapshot` drains.
 *   - `readSnapshot` returns the persisted shape.
 *   - `writeMeta` is atomic + carries schemaVersion + updatedAt + createdAt.
 *   - `readMeta` returns null on missing file.
 *   - `findResumableSession` picks the most recent <7d-old session.
 *
 * Headless: uses `fs.mkdtemp` to isolate the sessions dir per test; mocks
 * `electron` so `ipcMain.handle` etc. are inert. No app launch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  ipcMain: {
    handle: () => {},
    on: () => {},
    removeHandler: () => {},
    removeAllListeners: () => {},
  },
  BrowserWindow: class {},
}));

import {
  _resetSessionForTests,
  _resetSnapshotForTests,
  findResumableSession,
  forceFlushSnapshot,
  getSessionDir,
  initSession,
  readMeta,
  readSnapshot,
  SIDESTORE_SCHEMA_VERSION,
  writeMeta,
  writeStateSnapshot,
} from './side-store.js';

const ORIG_HOME = process.env['HOME'];
let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'side-store-test-'));
  process.env['HOME'] = workDir;
  _resetSessionForTests();
  _resetSnapshotForTests();
  await initSession({ sessionId: 'snap-test' });
});

afterEach(async () => {
  _resetSnapshotForTests();
  if (workDir) await rm(workDir, { recursive: true, force: true });
  if (ORIG_HOME != null) process.env['HOME'] = ORIG_HOME;
  else delete process.env['HOME'];
});

describe('writeStateSnapshot + forceFlushSnapshot', () => {
  it('does not write synchronously (debounced)', async () => {
    writeStateSnapshot({ goal: 'demo', agents: {} });
    // No flush yet — file should not exist.
    const dir = getSessionDir();
    expect(dir).not.toBeNull();
    const snap = await readSnapshot();
    expect(snap).toBeNull();
  });

  it('forceFlushSnapshot drains the queued snapshot to disk', async () => {
    writeStateSnapshot({ goal: 'demo', agents: { maya: { id: 'maya' } } });
    await forceFlushSnapshot();
    const snap = await readSnapshot();
    expect(snap).not.toBeNull();
    expect(snap?.schemaVersion).toBe(SIDESTORE_SCHEMA_VERSION);
    expect(snap?.at).toBeTypeOf('number');
    expect((snap?.store as { goal?: string })?.goal).toBe('demo');
    expect((snap?.store as { agents?: object })?.agents).toEqual({
      maya: { id: 'maya' },
    });
  });

  it('writes atomically — readback equals what was queued', async () => {
    const payload = { strip: { kind: 'dormant' }, transcript: [{ id: 'a' }] };
    writeStateSnapshot(payload);
    await forceFlushSnapshot();
    const dir = getSessionDir();
    const raw = await readFile(join(dir!, 'state.snapshot.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.store).toEqual(payload);
  });

  it('coalesces successive writes into the last value', async () => {
    writeStateSnapshot({ v: 1 });
    writeStateSnapshot({ v: 2 });
    writeStateSnapshot({ v: 3 });
    await forceFlushSnapshot();
    const snap = await readSnapshot();
    expect((snap?.store as { v?: number })?.v).toBe(3);
  });

  it('forceFlushSnapshot is a noop when nothing is queued', async () => {
    await expect(forceFlushSnapshot()).resolves.toBeUndefined();
  });
});

describe('writeMeta + readMeta', () => {
  it('returns null on a brand-new session', async () => {
    expect(await readMeta()).toBeNull();
  });

  it('round-trips a full meta record with schemaVersion 1', async () => {
    const written = await writeMeta({
      projectPath: '/Users/me/proj',
      targetAppDir: 'app',
      name: 'mixtape',
      appVersion: '0.0.1',
      currentGoal: 'ship the share feature',
    });
    expect(written.schemaVersion).toBe(SIDESTORE_SCHEMA_VERSION);
    expect(written.createdAt).toBeTypeOf('number');
    expect(written.updatedAt).toBeGreaterThanOrEqual(written.createdAt);

    const readBack = await readMeta();
    expect(readBack?.projectPath).toBe('/Users/me/proj');
    expect(readBack?.name).toBe('mixtape');
    expect(readBack?.currentGoal).toBe('ship the share feature');
  });

  it('preserves createdAt across subsequent writes (only updatedAt bumps)', async () => {
    const first = await writeMeta({ name: 'mixtape', currentGoal: 'a' });
    // Force a small wait so the next Date.now() is strictly larger.
    await new Promise((r) => setTimeout(r, 2));
    const second = await writeMeta({ currentGoal: 'b' });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(second.currentGoal).toBe('b');
    expect(second.name).toBe('mixtape'); // sticky from first write
  });

  it('null-coercion: explicit `currentGoal: null` clears the goal', async () => {
    await writeMeta({ currentGoal: 'something' });
    const cleared = await writeMeta({ currentGoal: null });
    expect(cleared.currentGoal).toBeNull();
  });
});

describe('findResumableSession', () => {
  // Use an isolated sessions dir per test so the scan is deterministic.
  async function makeSession(opts: {
    root: string;
    id: string;
    updatedAt: number;
    name?: string;
    goal?: string;
  }): Promise<string> {
    const dir = join(opts.root, opts.id);
    await mkdir(dir, { recursive: true });
    const meta = {
      schemaVersion: SIDESTORE_SCHEMA_VERSION,
      projectPath: `/Users/me/${opts.id}`,
      targetAppDir: null,
      name: opts.name ?? opts.id,
      createdAt: opts.updatedAt - 1000,
      updatedAt: opts.updatedAt,
      appVersion: '0.0.1',
      currentGoal: opts.goal ?? null,
    };
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta), 'utf8');
    return dir;
  }

  it('returns null when no sessions dir exists', async () => {
    const empty = join(workDir, 'no-sessions');
    expect(await findResumableSession({ sessionsRoot: empty })).toBeNull();
  });

  it('returns null when no session has a meta.json', async () => {
    const root = join(workDir, 'empty-sessions');
    await mkdir(join(root, 'a'), { recursive: true });
    expect(await findResumableSession({ sessionsRoot: root })).toBeNull();
  });

  it('picks the most recently updated session', async () => {
    const root = join(workDir, 'multi-sessions');
    const now = Date.now();
    await makeSession({ root, id: 'old', updatedAt: now - 60_000 });
    await makeSession({ root, id: 'mid', updatedAt: now - 30_000 });
    await makeSession({
      root,
      id: 'new',
      updatedAt: now - 1_000,
      goal: 'ship it',
    });
    const found = await findResumableSession({ sessionsRoot: root, now });
    expect(found?.sessionId).toBe('new');
    expect(found?.currentGoal).toBe('ship it');
    expect(found?.lastActiveAt).toBe(now - 1_000);
  });

  it('skips sessions older than the 7-day window', async () => {
    const root = join(workDir, 'stale-sessions');
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    await makeSession({ root, id: 'too-old', updatedAt: now - 10 * oneDay });
    expect(
      await findResumableSession({ sessionsRoot: root, now }),
    ).toBeNull();
  });

  it('the maxAgeMs override gates the resumable window', async () => {
    const root = join(workDir, 'window-sessions');
    const now = Date.now();
    await makeSession({ root, id: 'a', updatedAt: now - 5_000 });
    const tight = await findResumableSession({
      sessionsRoot: root,
      maxAgeMs: 1_000,
      now,
    });
    expect(tight).toBeNull();
    const loose = await findResumableSession({
      sessionsRoot: root,
      maxAgeMs: 10_000,
      now,
    });
    expect(loose?.sessionId).toBe('a');
  });
});
