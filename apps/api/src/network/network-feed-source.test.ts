import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/client';
import { createNetworkFeedSource, decodeFeedCursor, encodeFeedCursor } from './network-feed-source';

const id = '00000000-0000-4000-8000-000000000001';
const position = { p: 0 as const, t: '2026-11-20T12:34:56.123456Z', i: id };
const encode = (value: unknown) => btoa(JSON.stringify(value))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('Community Feed cursor validation', () => {
  it.each([0, 1] as const)('retains the exact microsecond boundary at rank %i', (p) => {
    const input = { ...position, p };
    expect(decodeFeedCursor(encodeFeedCursor(input))).toEqual(input);
  });

  it('accepts previously issued millisecond cursors', () => {
    const legacy = { ...position, t: '2026-11-20T12:34:56.123Z' };
    expect(decodeFeedCursor(encode(legacy))).toEqual(legacy);
  });

  it.each([
    null, [], {}, 'not an object',
    { ...position, p: 2 }, { ...position, p: '0' },
    { ...position, i: '-'.repeat(36) },
    { ...position, i: '00000000000040008000000000000001' },
    { ...position, i: `${id}' OR true--` },
    { ...position, t: 'infinity' },
    { ...position, t: '2026-02-30T12:34:56.123456Z' },
    { ...position, t: '2026-11-20T24:00:00.000000Z' },
    { ...position, t: '0000-11-20T12:34:56.123456Z' },
    { ...position, t: '2026-11-20T12:34:56.1234567Z' },
    { ...position, t: '2026-11-20T12:34:56.123456+00:00' },
  ])('refuses invalid cursor payload %j before persistence', async (input) => {
    const cursor = encode(input);
    expect(decodeFeedCursor(cursor)).toBeNull();
    const select = vi.fn();
    const source = createNetworkFeedSource({ select } as unknown as Database);
    await expect(source.listVisible({ customerId: id, cursor, limit: 20 }))
      .resolves.toEqual({ items: [], nextCursor: null });
    expect(select).not.toHaveBeenCalled();
  });

  it.each(['bad*cursor', 'a'.repeat(201), 'e30'])('bounds malformed envelopes: %s', (cursor) => {
    expect(decodeFeedCursor(cursor)).toBeNull();
  });
});
