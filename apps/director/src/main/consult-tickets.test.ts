/**
 * Tests for the async consult ticket engine (consult-tickets.ts) — the
 * fire-and-forget `consult_director` protocol from docs/voice-genui-spec.md §1.
 *
 * Headless: the registry takes the Brain `runner` and the `deliver` sink as
 * injected functions, so nothing here mocks Electron or OpenAI. We assert:
 *   - registry round-trip + unique ids + close / double-close semantics
 *   - `restate` collapses + strips + clamps deterministically (no model call)
 *   - resolve → deliver attributed "On <restated>: <summary>"
 *   - reject  → deliver "Couldn't get to the bottom of <restated>."
 *   - empty summary is a soft failure (error text, not a bare "On X:")
 *   - multiple concurrent tickets each deliver independently + close
 *   - `runTicket` returns synchronously (non-blocking) even for a slow runner
 *   - the ticket is removed from the map after delivery (finally)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetTicketsForTests,
  closeTicket,
  completeTicket,
  dispatchConsult,
  errorText,
  getTicket,
  listTickets,
  openTicket,
  restate,
  resultText,
  runTicket,
  type ConsultDelivery,
} from './consult-tickets.js';

afterEach(() => {
  _resetTicketsForTests();
});

/** A deliver sink that records every delivery. */
function recordingDeliver(): { deliveries: ConsultDelivery[]; deliver: (p: ConsultDelivery) => void } {
  const deliveries: ConsultDelivery[] = [];
  return { deliveries, deliver: (p) => deliveries.push(p) };
}

/** Wait one microtask flush + a macrotask so all chained .then/.finally run. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe('registry — openTicket / getTicket / closeTicket', () => {
  it('openTicket returns a unique id and stores the row', () => {
    const id1 = openTicket('prompt one', 'topic one');
    const id2 = openTicket('prompt two', 'topic two');
    expect(id1).not.toEqual(id2);
    expect(id1).toMatch(/^consult-\d+-[a-z0-9]+$/);

    const row = getTicket(id1);
    expect(row).toBeDefined();
    expect(row?.prompt).toBe('prompt one');
    expect(row?.restated).toBe('topic one');
    expect(typeof row?.startedAt).toBe('number');
  });

  it('accepts the spec-doc §1.3 row-object form', () => {
    const id = openTicket({ prompt: 'p', restated: 'r' });
    expect(getTicket(id)).toMatchObject({ prompt: 'p', restated: 'r' });
  });

  it('derives a restate when none is passed', () => {
    const id = openTicket('Should we split the API by resource?');
    expect(getTicket(id)?.restated).toBe('split the API by resource');
  });

  it('closeTicket deletes + returns the row; double-close returns undefined', () => {
    const id = openTicket('prompt', 'topic');
    const closed = closeTicket(id);
    expect(closed?.prompt).toBe('prompt');
    expect(getTicket(id)).toBeUndefined();
    expect(closeTicket(id)).toBeUndefined();
  });

  it('completeTicket is the same function as closeTicket', () => {
    expect(completeTicket).toBe(closeTicket);
  });

  it('listTickets returns in-flight rows oldest-first', () => {
    const a = openTicket('a', 'a');
    const b = openTicket('b', 'b');
    const ids = listTickets().map((t) => t.ticketId);
    expect(ids).toEqual([a, b]);
    expect(listTickets()).toHaveLength(2);
  });
});

describe('restate (pure)', () => {
  it('collapses whitespace + newlines to one line', () => {
    expect(restate('  build   the\n  thing  ')).toBe('build the thing');
  });

  it('strips a leading question stem and trailing question mark', () => {
    expect(restate('how should we structure the auth module?')).toBe(
      'structure the auth module',
    );
    expect(restate('What is the best way to cache the feed?')).toBe('cache the feed');
  });

  it('strips conversational filler stems', () => {
    expect(restate('so, refactor the router')).toBe('refactor the router');
  });

  it('clamps to <=80 chars on a word boundary with an ellipsis', () => {
    const long =
      'redesign the entire persistence layer to use an append only event log with snapshots and compaction across every session directory';
    const out = restate(long);
    expect(out.length).toBeLessThanOrEqual(81); // 80 + the ellipsis char
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('\n');
  });

  it('falls back to "that" on empty / whitespace input', () => {
    expect(restate('')).toBe('that');
    expect(restate('   ')).toBe('that');
    // A nullish prompt must not throw.
    expect(restate(undefined as unknown as string)).toBe('that');
  });
});

describe('attribution text (pure)', () => {
  it('resultText applies the fixed "On <restated>: <summary>" prefix', () => {
    expect(resultText('whether to split the API', 'Yes — split by resource now.')).toBe(
      'On whether to split the API: Yes — split by resource now.',
    );
  });

  it('errorText is the fixed graceful failure line', () => {
    expect(errorText('whether to split the API')).toBe(
      "Couldn't get to the bottom of whether to split the API.",
    );
  });
});

describe('runTicket — async lifecycle', () => {
  it('resolve → deliver attributed result text, then closes the ticket', async () => {
    const { deliveries, deliver } = recordingDeliver();
    const id = openTicket('split the API by resource?', 'whether to split the API');

    runTicket(id, async () => ({ summary: 'Yes; split by resource now.' }), deliver);
    // Non-blocking: nothing delivered yet, ticket still open.
    expect(deliveries).toHaveLength(0);
    expect(getTicket(id)).toBeDefined();

    await flush();

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      ticketId: id,
      restated: 'whether to split the API',
      outcome: 'result',
      text: 'On whether to split the API: Yes; split by resource now.',
    });
    // Closed in finally.
    expect(getTicket(id)).toBeUndefined();
  });

  it('reject → deliver the error line, then closes the ticket', async () => {
    const { deliveries, deliver } = recordingDeliver();
    const id = openTicket('p', 'the database migration');

    runTicket(id, async () => {
      throw new Error('brain blew up');
    }, deliver);

    await flush();

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      ticketId: id,
      outcome: 'error',
      text: "Couldn't get to the bottom of the database migration.",
    });
    expect(getTicket(id)).toBeUndefined();
  });

  it('a synchronous throw inside the runner does NOT propagate to the caller', async () => {
    const { deliveries, deliver } = recordingDeliver();
    const id = openTicket('p', 'the sync thrower');

    // The runner throws synchronously (before returning a promise). runTicket
    // must swallow it onto the error path, not throw on the voice-return path.
    expect(() =>
      runTicket(
        id,
        (() => {
          throw new Error('sync boom');
        }) as never,
        deliver,
      ),
    ).not.toThrow();

    await flush();
    expect(deliveries[0]?.outcome).toBe('error');
    expect(getTicket(id)).toBeUndefined();
  });

  it('an empty/whitespace summary is a soft failure (error text)', async () => {
    const { deliveries, deliver } = recordingDeliver();
    const id = openTicket('p', 'the empty answer');

    runTicket(id, async () => ({ summary: '   ' }), deliver);
    await flush();

    expect(deliveries[0]).toMatchObject({
      outcome: 'error',
      text: "Couldn't get to the bottom of the empty answer.",
    });
  });

  it('unknown ticketId no-ops (no throw, no delivery)', async () => {
    const { deliveries, deliver } = recordingDeliver();
    expect(() => runTicket('consult-does-not-exist', async () => ({ summary: 'x' }), deliver)).not.toThrow();
    await flush();
    expect(deliveries).toHaveLength(0);
  });

  it('multiple concurrent tickets each deliver independently', async () => {
    const { deliveries, deliver } = recordingDeliver();

    const idA = openTicket('a', 'topic A');
    const idB = openTicket('b', 'topic B');
    const idC = openTicket('c', 'topic C');

    // A resolves fast, B rejects, C resolves slowly — all in flight at once.
    runTicket(idA, async () => ({ summary: 'answer A' }), deliver);
    runTicket(idB, async () => {
      throw new Error('B failed');
    }, deliver);
    runTicket(
      idC,
      () => new Promise((res) => setTimeout(() => res({ summary: 'answer C' }), 5)),
      deliver,
    );

    // All three tickets open immediately, nothing delivered synchronously.
    expect(listTickets()).toHaveLength(3);
    expect(deliveries).toHaveLength(0);

    await flush();
    // Give the slow (5ms) ticket time.
    await new Promise((r) => setTimeout(r, 15));

    expect(deliveries).toHaveLength(3);
    const byId = Object.fromEntries(deliveries.map((d) => [d.ticketId, d]));
    expect(byId[idA]).toMatchObject({ outcome: 'result', text: 'On topic A: answer A' });
    expect(byId[idB]).toMatchObject({
      outcome: 'error',
      text: "Couldn't get to the bottom of topic B.",
    });
    expect(byId[idC]).toMatchObject({ outcome: 'result', text: 'On topic C: answer C' });

    // Every ticket closed.
    expect(listTickets()).toHaveLength(0);
  });
});

describe('dispatchConsult — open + run convenience', () => {
  it('returns { ticketId, restated } synchronously and kicks the run', async () => {
    const { deliveries, deliver } = recordingDeliver();
    const runner = vi.fn(async () => ({ summary: 'done thinking' }));

    const { ticketId, restated } = dispatchConsult(
      'How should we shard the queue?',
      runner,
      deliver,
    );

    expect(ticketId).toMatch(/^consult-/);
    expect(restated).toBe('shard the queue');
    // Runner kicked, but consult result not delivered synchronously.
    expect(deliveries).toHaveLength(0);

    await flush();
    expect(runner).toHaveBeenCalledWith('How should we shard the queue?');
    expect(deliveries[0]).toMatchObject({
      ticketId,
      outcome: 'result',
      text: 'On shard the queue: done thinking',
    });
  });

  it('honors an explicit restatedHint over the derived restate', () => {
    const { deliver } = recordingDeliver();
    const { restated } = dispatchConsult(
      'long rambly prompt that we do not want to echo',
      async () => ({ summary: 's' }),
      deliver,
      'the queue sharding question',
    );
    expect(restated).toBe('the queue sharding question');
  });
});
