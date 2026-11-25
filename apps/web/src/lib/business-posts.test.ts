import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('./api-client', () => ({ apiFetch: vi.fn(), ApiError: class ApiError extends Error {} }));

import { parseBusinessPost, parseBusinessPosts } from './business-posts';

const valid = { handle: 'AbCdEfGhIjKlMnOpQrStUv', stage: 'live', latestRevisionNo: 2, reasonCode: null, body: 'Hello', linkUrl: null, contentLocale: 'en', publishedAt: '2026-01-02T10:00:00.000Z', createdAt: '2026-01-01T10:00:00.000Z' };

describe('parseBusinessPost / parseBusinessPosts (BCOMM-03)', () => {
  it('accepts the documented shape', () => {
    expect(parseBusinessPost(valid)).toMatchObject({ handle: valid.handle, stage: 'live' });
    expect(parseBusinessPosts([valid, { ...valid, stage: 'rejected', reasonCode: 'spam_or_duplicate' }])).toMatchObject({ state: 'ready' });
    expect(parseBusinessPosts([])).toEqual({ state: 'ready', posts: [] });
  });
  it('rejects anything else, and one bad row makes the whole list unavailable', () => {
    for (const bad of [null, 'x', {}, { ...valid, handle: 'short' }, { ...valid, stage: 'published' }, { ...valid, latestRevisionNo: 0 }, { ...valid, body: 5 }, { ...valid, linkUrl: 5 }]) {
      expect(parseBusinessPost(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseBusinessPosts([valid, { ...valid, stage: 'nope' }])).toEqual({ state: 'unavailable' });
    expect(parseBusinessPosts({})).toEqual({ state: 'unavailable' });
  });
});
