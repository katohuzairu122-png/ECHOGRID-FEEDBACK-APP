import { describe, expect, it } from 'vitest';
import { networkFeedItemSchema, networkFeedPageSchema } from '@echo-grid-feedback/shared-types';

const item = {
  handle: 'abcdefghijklmnopqrstuv',
  contentClass: 'official',
  businessName: null,
  body: 'Published update',
  linkUrl: 'https://example.test/update',
  contentLocale: 'en',
  publishedAt: '2026-11-21T10:00:00.000Z',
};

describe('existing closed Network Feed response contract', () => {
  it('projects only customer fields, including future unknown fields', () => {
    expect(
      networkFeedPageSchema.parse({
        items: [
          { ...item, customerId: 'private', reviewerId: 'private', metadata: { secret: true } },
        ],
        nextCursor: 'existing_cursor',
        audit: { secret: true },
      }),
    ).toEqual({ items: [item], nextCursor: 'existing_cursor' });
  });

  it.each([
    null,
    {},
    { items: null, nextCursor: null },
    { items: [], nextCursor: undefined },
    { items: [], nextCursor: '' },
    { items: [], nextCursor: '../unsafe' },
    { items: [], nextCursor: 'a'.repeat(201) },
    { items: [], nextCursor: {} },
    { items: Array.from({ length: 51 }, () => item), nextCursor: null },
  ])('rejects malformed or unbounded pages: %j', (page) => {
    expect(networkFeedPageSchema.safeParse(page).success).toBe(false);
  });

  it.each([
    { handle: 'short' },
    { contentClass: 'unrestricted' },
    { businessName: { private: true } },
    { body: null },
    { body: '' },
    { body: 'a'.repeat(2001) },
    { linkUrl: 'javascript:alert(1)' },
    { linkUrl: 'http://example.test' },
    { contentLocale: { private: true } },
    { publishedAt: 'not-a-date' },
    { publishedAt: null },
  ])('rejects invalid rendering fields: %j', (patch) => {
    expect(networkFeedItemSchema.safeParse({ ...item, ...patch }).success).toBe(false);
  });

  it('keeps the existing page bound and nullable values', () => {
    expect(
      networkFeedPageSchema.parse({
        items: Array.from({ length: 50 }, () => item),
        nextCursor: null,
      }).items,
    ).toHaveLength(50);
    expect(networkFeedPageSchema.parse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    });
    const linkUrl = ' https://EXAMPLE.test/unchanged ';
    expect(networkFeedItemSchema.parse({ ...item, linkUrl }).linkUrl).toBe(linkUrl);
  });
});
