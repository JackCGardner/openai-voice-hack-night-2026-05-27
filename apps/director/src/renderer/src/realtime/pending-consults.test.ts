/**
 * Tests for the pure pending-consult tracker (pending-consults.ts) — the
 * renderer bookkeeping that suppresses idle-teardown while an async
 * `consult_director` is in flight (demo-critical: a slow consult answer was
 * being dropped because the 45s idle-teardown closed the peer mid-think).
 *
 * Headless + pure: no React, no Electron, no timers. We pin the load-bearing
 * invariants:
 *   - hold edge fires once on empty → non-empty; release edge once on
 *     non-empty → empty (so client.holdPeer is called once per edge).
 *   - add / resolve are idempotent per ticketId (duplicate events, redelivered
 *     announces, replays) — the count never goes negative and never
 *     double-holds.
 *   - resolving an unknown / non-consult ticketId is a no-op.
 *   - empty / missing ticketIds are ignored (an untracked consult would pin
 *     the peer open forever).
 *   - the announce / tool-result extractors only fire on the right shapes.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PendingConsults,
  consultTicketIdFromAnnounce,
  thinkingTicketIdFromToolResult,
} from './pending-consults.js';

describe('PendingConsults — hold/release edges', () => {
  it('fires hold(true) once on the first ticket, hold(false) once on the last', () => {
    const onHold = vi.fn();
    const p = new PendingConsults(onHold);

    expect(p.held).toBe(false);
    expect(p.size).toBe(0);

    // First ticket → hold edge.
    expect(p.add('t1')).toBe(true);
    expect(p.held).toBe(true);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onHold).toHaveBeenLastCalledWith(true);

    // Second + third tickets → no new edge.
    expect(p.add('t2')).toBe(false);
    expect(p.add('t3')).toBe(false);
    expect(p.size).toBe(3);
    expect(onHold).toHaveBeenCalledTimes(1); // still just the one hold(true)

    // Resolve two of three → still held, no release yet.
    expect(p.resolve('t1')).toBe(false);
    expect(p.resolve('t2')).toBe(false);
    expect(p.held).toBe(true);
    expect(onHold).toHaveBeenCalledTimes(1);

    // Resolve the last → release edge.
    expect(p.resolve('t3')).toBe(true);
    expect(p.held).toBe(false);
    expect(p.size).toBe(0);
    expect(onHold).toHaveBeenCalledTimes(2);
    expect(onHold).toHaveBeenLastCalledWith(false);
  });

  it('cycles hold/release across separate consults', () => {
    const onHold = vi.fn();
    const p = new PendingConsults(onHold);

    p.add('a');
    p.resolve('a');
    p.add('b');
    p.resolve('b');

    expect(onHold.mock.calls.map((c) => c[0])).toEqual([true, false, true, false]);
    expect(p.held).toBe(false);
  });
});

describe('PendingConsults — idempotency + negative guards', () => {
  it('add is idempotent per ticketId (no double-hold, no double-count)', () => {
    const onHold = vi.fn();
    const p = new PendingConsults(onHold);

    expect(p.add('dup')).toBe(true);
    expect(p.add('dup')).toBe(false); // duplicate add — ignored
    expect(p.add('dup')).toBe(false);
    expect(p.size).toBe(1);
    expect(onHold).toHaveBeenCalledTimes(1);

    // A single resolve clears it, even after multiple adds.
    expect(p.resolve('dup')).toBe(true);
    expect(p.size).toBe(0);
    expect(onHold).toHaveBeenCalledTimes(2);
  });

  it('resolve is idempotent + safe for unknown ids (count never goes negative)', () => {
    const onHold = vi.fn();
    const p = new PendingConsults(onHold);

    // Resolve before any add — no-op, no release edge.
    expect(p.resolve('ghost')).toBe(false);
    expect(p.held).toBe(false);
    expect(onHold).not.toHaveBeenCalled();

    p.add('real');
    expect(p.resolve('real')).toBe(true);
    // Double-resolve (redelivered announce / reconnect replay) → no-op.
    expect(p.resolve('real')).toBe(false);
    expect(p.resolve('unknown')).toBe(false);
    expect(p.size).toBe(0);
    // Exactly one hold(true) + one hold(false) — no spurious extra edges.
    expect(onHold.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  it('ignores empty / missing ticketIds on both add and resolve', () => {
    const onHold = vi.fn();
    const p = new PendingConsults(onHold);

    expect(p.add('')).toBe(false);
    expect(p.add(null)).toBe(false);
    expect(p.add(undefined)).toBe(false);
    expect(p.resolve('')).toBe(false);
    expect(p.resolve(null)).toBe(false);
    expect(p.resolve(undefined)).toBe(false);
    expect(p.size).toBe(0);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('clear() drops everything and fires a single release edge', () => {
    const onHold = vi.fn();
    const p = new PendingConsults(onHold);

    p.add('x');
    p.add('y');
    onHold.mockClear();

    p.clear();
    expect(p.held).toBe(false);
    expect(p.size).toBe(0);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onHold).toHaveBeenLastCalledWith(false);

    // clear() when already empty is a no-op (no spurious release).
    p.clear();
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it('works without an onHoldChange callback (pure counting)', () => {
    const p = new PendingConsults();
    expect(p.add('t')).toBe(true);
    expect(p.held).toBe(true);
    expect(p.has('t')).toBe(true);
    expect(p.resolve('t')).toBe(true);
    expect(p.held).toBe(false);
  });
});

describe('consultTicketIdFromAnnounce', () => {
  it('returns the ticketId for consult_result / consult_error announces', () => {
    expect(
      consultTicketIdFromAnnounce({
        metadata: { kind: 'consult_result', ticketId: 'consult-1' },
      }),
    ).toBe('consult-1');
    expect(
      consultTicketIdFromAnnounce({
        metadata: { kind: 'consult_error', ticketId: 'consult-2' },
      }),
    ).toBe('consult-2');
  });

  it('returns null for non-consult announces (e.g. hang watchdog) + bad shapes', () => {
    // Hang watchdog: kind:'agent_hang_suspected', no ticketId → must NOT decrement.
    expect(
      consultTicketIdFromAnnounce({
        metadata: { kind: 'agent_hang_suspected', agentId: 'maya' },
      }),
    ).toBeNull();
    expect(consultTicketIdFromAnnounce({})).toBeNull();
    expect(consultTicketIdFromAnnounce({ metadata: undefined })).toBeNull();
    expect(
      consultTicketIdFromAnnounce({ metadata: { kind: 'consult_result' } }),
    ).toBeNull(); // missing ticketId
    expect(
      consultTicketIdFromAnnounce({ metadata: { kind: 'consult_result', ticketId: '' } }),
    ).toBeNull();
  });
});

describe('thinkingTicketIdFromToolResult', () => {
  it('returns the ticketId for a status:thinking result', () => {
    expect(
      thinkingTicketIdFromToolResult({
        status: 'thinking',
        ticketId: 'consult-9',
        restated: 'split the API',
      }),
    ).toBe('consult-9');
  });

  it('returns null for non-thinking / malformed results', () => {
    expect(thinkingTicketIdFromToolResult({ answer: 'done' })).toBeNull();
    expect(thinkingTicketIdFromToolResult({ status: 'thinking' })).toBeNull(); // no ticketId
    expect(thinkingTicketIdFromToolResult(null)).toBeNull();
    expect(thinkingTicketIdFromToolResult('thinking')).toBeNull();
    expect(thinkingTicketIdFromToolResult({ status: 'done', ticketId: 'x' })).toBeNull();
  });
});

describe('integration shape — announce ↔ tool-result correlate by ticketId', () => {
  it('add via tool result, resolve via the matching announce', () => {
    const onHold = vi.fn();
    const p = new PendingConsults(onHold);

    const toolResult = { status: 'thinking', ticketId: 'consult-42', restated: 'auth' };
    const tid = thinkingTicketIdFromToolResult(toolResult);
    expect(tid).toBe('consult-42');
    p.add(tid);
    expect(p.held).toBe(true);

    // An unrelated hang announce must NOT release the consult.
    const hang = { metadata: { kind: 'agent_hang_suspected', agentId: 'jin' } };
    p.resolve(consultTicketIdFromAnnounce(hang));
    expect(p.held).toBe(true);

    // The matching consult announce releases it.
    const answer = {
      text: 'On auth: use sessions.',
      metadata: { kind: 'consult_result', ticketId: 'consult-42' },
    };
    p.resolve(consultTicketIdFromAnnounce(answer));
    expect(p.held).toBe(false);
    expect(onHold.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });
});
