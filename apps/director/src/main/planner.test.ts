/**
 * Thin integration test for the planner chain:
 *   - Call 1 (cold session): NO `previous_response_id` in body.
 *   - Call 2 (chained): `previous_response_id` === call 1's `response.id`.
 *   - orchestrator.jsonl contains 2 `kind: 'response'` lines, the second
 *     pointing at the first via `previousResponseId`.
 *
 * Mocks:
 *   - fetch (injected via `_setFetchForTests`) — yields an SSE stream
 *     with `response.created`, `response.output_text.delta`, and
 *     `response.completed`.
 *   - electron's `ipcMain` (NOT touched — we only call `consultDirector`
 *     directly).
 *   - the side store — we run a real one in a temp dir so the
 *     orchestrator.jsonl writer is exercised end-to-end.
 *
 * Headless: no Electron BrowserWindow, no real network.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock electron BEFORE importing anything that pulls it in (side-store +
// planner both import { ipcMain } from 'electron'). The mock returns a
// no-op `handle` so `registerSideStoreIpc` / `registerPlannerDevIpc`
// don't blow up if called — but we don't call them in this test.
import { vi } from 'vitest';
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
  _resetPlannerStateForTests,
  _setFetchForTests,
  _getLastResponseIdForTests,
  consultDirector,
} from './planner.js';
import {
  _resetSessionForTests,
  initSession,
  getSessionDir,
} from './side-store.js';

const ORIG_API_KEY = process.env.OPENAI_API_KEY;
const ORIG_HOME = process.env.HOME;

let workDir: string;
let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;

/**
 * Build an SSE stream out of a sequence of event objects. The planner
 * reader uses fetch's `body.getReader()`, so we ship a ReadableStream
 * (not a string).
 */
function makeSseStream(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = events.map(
    (event) => `data: ${JSON.stringify(event)}\n\n`,
  );
  // Append the SSE terminator.
  chunks.push('data: [DONE]\n\n');
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function buildMockFetch(
  responses: Array<{ events: Array<Record<string, unknown>> }>,
): typeof fetch {
  let callIdx = 0;
  return async (url, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    fetchCalls.push({
      url: typeof url === 'string' ? url : String(url),
      body,
    });
    const next = responses[callIdx] ?? responses[responses.length - 1];
    callIdx += 1;
    if (!next) throw new Error('no mock response configured');
    const stream = makeSseStream(next.events);
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
}

beforeEach(async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  workDir = await mkdtemp(join(tmpdir(), 'planner-test-'));
  process.env.HOME = workDir;
  _resetSessionForTests();
  _resetPlannerStateForTests();
  fetchCalls = [];
  await initSession({ sessionId: 'planner-test' });
});

afterEach(async () => {
  _setFetchForTests(null);
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
  }
  if (ORIG_HOME != null) process.env.HOME = ORIG_HOME;
  else delete process.env.HOME;
  if (ORIG_API_KEY != null) process.env.OPENAI_API_KEY = ORIG_API_KEY;
  else delete process.env.OPENAI_API_KEY;
});

describe('consultDirector chaining', () => {
  it('omits previous_response_id on first call and passes it on second', async () => {
    _setFetchForTests(
      buildMockFetch([
        {
          events: [
            {
              type: 'response.created',
              response: { id: 'resp_first', usage: null },
            },
            { type: 'response.output_text.delta', delta: 'hello' },
            {
              type: 'response.completed',
              response: {
                id: 'resp_first',
                usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
              },
            },
          ],
        },
        {
          events: [
            {
              type: 'response.created',
              response: { id: 'resp_second', usage: null },
            },
            { type: 'response.output_text.delta', delta: 'world' },
            {
              type: 'response.completed',
              response: {
                id: 'resp_second',
                usage: { input_tokens: 80, output_tokens: 40, total_tokens: 120 },
              },
            },
          ],
        },
      ]),
    );

    await consultDirector({ prompt: 'plan the share feature' });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.body.previous_response_id).toBeUndefined();
    expect(fetchCalls[0]!.body.store).toBe(false);
    expect(fetchCalls[0]!.body.context_management).toEqual([
      { type: 'compaction', compact_threshold: 180_000 },
    ]);
    expect(_getLastResponseIdForTests()).toBe('resp_first');

    await consultDirector({ prompt: 'OK do it but free tier only' });
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]!.body.previous_response_id).toBe('resp_first');
    expect(_getLastResponseIdForTests()).toBe('resp_second');

    // Inspect orchestrator.jsonl — two response lines, second chained.
    const dir = getSessionDir();
    expect(dir).not.toBeNull();
    const raw = await readFile(join(dir!, 'orchestrator.jsonl'), 'utf8');
    const lines = raw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      kind: 'response',
      responseId: 'resp_first',
      previousResponseId: null,
      model: 'gpt-5',
    });
    expect(lines[1]).toMatchObject({
      kind: 'response',
      responseId: 'resp_second',
      previousResponseId: 'resp_first',
      model: 'gpt-5',
    });
  });

  it('boots lastResponseId from orchestrator.jsonl tail on a fresh process', async () => {
    // First, seed the chain via a real call so the file is written.
    _setFetchForTests(
      buildMockFetch([
        {
          events: [
            {
              type: 'response.created',
              response: { id: 'resp_seed' },
            },
            {
              type: 'response.completed',
              response: {
                id: 'resp_seed',
                usage: { input_tokens: 50, output_tokens: 25, total_tokens: 75 },
              },
            },
          ],
        },
      ]),
    );
    await consultDirector({ prompt: 'seed call' });
    expect(_getLastResponseIdForTests()).toBe('resp_seed');

    // Simulate a process restart: clear in-memory chain but keep the
    // session dir intact. The next consult should boot the chain head
    // from disk and pass it as `previous_response_id`.
    _resetPlannerStateForTests();
    expect(_getLastResponseIdForTests()).toBeNull();

    _setFetchForTests(
      buildMockFetch([
        {
          events: [
            {
              type: 'response.created',
              response: { id: 'resp_after_restart' },
            },
            {
              type: 'response.completed',
              response: {
                id: 'resp_after_restart',
                usage: { input_tokens: 60, output_tokens: 30 },
              },
            },
          ],
        },
      ]),
    );
    await consultDirector({ prompt: 'follow-up after restart' });
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]!.body.previous_response_id).toBe('resp_seed');
    expect(_getLastResponseIdForTests()).toBe('resp_after_restart');
  });
});
