import { describe, expect, it, vi } from 'vitest';
import {
  RESERVED_SLUGS, canonicalSlugSchema, createBranchSchema, createBusinessSchema, isCanonicalSlug,
  slugBaseFromName, slugCandidate, updateBranchSchema,
} from '@echo-grid-feedback/shared-types';
import { allocateSlug, MAX_SLUG_ATTEMPTS, suggestSlug } from './slug-allocation';

describe('slugBaseFromName', () => {
  it.each([
    ['Joe’s Café & Bar', 'joe-s-cafe-and-bar'],
    ['  The   Daily   Grind  ', 'the-daily-grind'],
    ['Crème Brûlée!!', 'creme-brulee'],
    ['Store #5 (Downtown)', 'store-5-downtown'],
    ['UPPER lower 123', 'upper-lower-123'],
    ['---weird---', 'weird'],
  ])('derives a canonical base from %j', (name, expected) => {
    expect(slugBaseFromName(name, 'business')).toBe(expected);
    expect(isCanonicalSlug(expected)).toBe(true);
  });

  it('falls back when the name has no Latin letters or digits (for example Arabic only)', () => {
    expect(slugBaseFromName('مقهى النخيل', 'business')).toBe('business');
    expect(slugBaseFromName('☕️', 'branch')).toBe('branch');
    expect(slugBaseFromName('a', 'branch')).toBe('branch');
  });

  it('caps the base so a suffix still fits in 60 characters and never ends with a hyphen', () => {
    const base = slugBaseFromName(`${'a'.repeat(49)} ${'b'.repeat(40)}`, 'business');
    expect(base.length).toBeLessThanOrEqual(50);
    expect(base.endsWith('-')).toBe(false);
    for (const n of [1, 2, 9, 10, 99, 1000]) {
      const candidate = slugCandidate(base, n)!;
      expect(candidate.length).toBeLessThanOrEqual(60);
      expect(isCanonicalSlug(candidate)).toBe(true);
    }
  });

  it('is deterministic', () => {
    expect(slugBaseFromName('Same Name', 'business')).toBe(slugBaseFromName('Same Name', 'business'));
  });
});

describe('slugCandidate', () => {
  it('is the base first, then base-2, base-3 ...', () => {
    expect([1, 2, 3].map((n) => slugCandidate('cafe', n))).toEqual(['cafe', 'cafe-2', 'cafe-3']);
  });
  it('skips a reserved base only for the bare name', () => {
    expect(slugCandidate('admin', 1)).toBeNull();
    expect(slugCandidate('admin', 2)).toBe('admin-2');
  });
});

describe('canonical slug validation (new input)', () => {
  it.each(['cafe', 'my-cafe-2', 'a1', 'x'.repeat(60)])('accepts %s', (value) => {
    expect(canonicalSlugSchema.safeParse(value).success).toBe(true);
  });
  it.each(['a', '', '-cafe', 'cafe-', 'my--cafe', 'My Cafe!', 'café', 'x'.repeat(61), 'admin', 'api', 'login'])('rejects %j', (value) => {
    expect(canonicalSlugSchema.safeParse(value).success).toBe(false);
  });
  it('normalizes case and whitespace like the existing rule', () => {
    expect(canonicalSlugSchema.parse('  My-Cafe ')).toBe('my-cafe');
  });
  it('lists the reserved words', () => {
    expect(RESERVED_SLUGS.has('dashboard')).toBe(true);
  });
});

describe('create contracts', () => {
  it('a business can be created with no slug at all', () => {
    expect(createBusinessSchema.safeParse({ name: 'My Cafe' }).success).toBe(true);
  });
  it('a branch can be created with no slug at all', () => {
    expect(createBranchSchema.safeParse({ name: 'Main Street' }).success).toBe(true);
  });
  it('an explicit non-canonical slug cannot bypass server validation on create', () => {
    expect(createBusinessSchema.safeParse({ name: 'x', slug: 'bad--slug' }).success).toBe(false);
    expect(createBranchSchema.safeParse({ name: 'x', slug: '-bad' }).success).toBe(false);
    expect(createBusinessSchema.safeParse({ name: 'x', slug: 'ADMIN' }).success).toBe(false);
  });
  it('an existing legacy slug can still be sent unchanged on a branch update', () => {
    expect(updateBranchSchema.safeParse({ slug: 'old--legacy-' }).success).toBe(true);
  });
});

describe('allocateSlug', () => {
  it('returns the first free candidate and never retries past it', async () => {
    const taken = new Set(['cafe', 'cafe-2']);
    const attempt = vi.fn(async (slug: string) => (taken.has(slug) ? undefined : { slug }));
    const result = await allocateSlug('Cafe', 'business', attempt);
    expect(result.slug).toBe('cafe-3');
    expect(attempt.mock.calls.map((c) => c[0])).toEqual(['cafe', 'cafe-2', 'cafe-3']);
  });
  it('gives up with an actionable 409 after the attempt limit', async () => {
    await expect(allocateSlug('Cafe', 'business', async () => undefined)).rejects.toMatchObject({
      status: 409, code: 'SLUG_UNAVAILABLE',
    });
  });
  it('makes at most MAX_SLUG_ATTEMPTS attempts', async () => {
    const attempt = vi.fn(async () => undefined);
    await allocateSlug('Cafe', 'business', attempt).catch(() => undefined);
    expect(attempt.mock.calls.length).toBeLessThanOrEqual(MAX_SLUG_ATTEMPTS);
  });
});

describe('suggestSlug', () => {
  it('offers the first free candidate without writing', async () => {
    expect(await suggestSlug('Cafe', 'business', async (slug) => slug === 'cafe')).toBe('cafe-2');
  });
});
