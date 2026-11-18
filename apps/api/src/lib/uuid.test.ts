import { describe, expect, it } from 'vitest';
import { isUuid } from './uuid';

describe('isUuid', () => {
  it('accepts a generated uuid in either case', () => {
    const id = crypto.randomUUID();
    expect(isUuid(id)).toBe(true);
    expect(isUuid(id.toUpperCase())).toBe(true);
  });

  it('accepts any 8-4-4-4-12 hex string, as Postgres does (not only RFC-versioned ids)', () => {
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(isUuid('11111111-1111-1111-1111-111111111111')).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['free text', 'not-a-uuid'],
    ['a short id', 'grant-1'],
    ['a uuid with a trailing character', `${crypto.randomUUID()}x`],
    ['a uuid with leading whitespace', ` ${crypto.randomUUID()}`],
    ['a uuid with a newline appended', `${crypto.randomUUID()}\n`],
    ['a uuid without hyphens', crypto.randomUUID().replaceAll('-', '')],
    ['a non-hex character', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'],
    ['a SQL fragment', "' OR 1=1 --"],
  ])('rejects %s', (_label, value) => {
    expect(isUuid(value)).toBe(false);
  });
});
