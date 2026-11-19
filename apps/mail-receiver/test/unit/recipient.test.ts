import { describe, expect, it } from 'vitest';
import { parseRecipient } from '../../src/recipient';
import { DOMAIN } from '../helpers/email';

describe('synthetic recipient namespace', () => {
  it('accepts acc-<run>-<label>@<approved domain>, case-insensitively', () => {
    expect(parseRecipient(`acc-abcd1234-main@${DOMAIN}`, DOMAIN)).toEqual({ address: `acc-abcd1234-main@${DOMAIN}`, runId: 'abcd1234', label: 'main' });
    expect(parseRecipient(`ACC-ABCD1234-Main@${DOMAIN.toUpperCase()}`, DOMAIN)?.runId).toBe('abcd1234');
  });
  it.each([
    'someone@acc-test.example',
    'acc-abc-main@acc-test.example',
    'acc-abcd1234@acc-test.example',
    'acc-abcd1234-@acc-test.example',
    'acc-abcd1234-ma.in@acc-test.example',
    'acc-abcd1234-main+tag@acc-test.example',
    'acc-abcd1234-main@other.example',
    'acc-abcd1234-main@sub.acc-test.example',
    'acc-abcd1234-main@acc-test.example.evil.example',
    'acc-abcd1234-main@@acc-test.example',
    'a@b@acc-abcd1234-main@acc-test.example',
    'acc-abcd1234-main@acc-test.example\r\nBcc: x@y.example',
    '../acc-abcd1234-main@acc-test.example',
    `acc-abcd1234-${'x'.repeat(17)}@acc-test.example`,
    '',
  ])('refuses %j', (addr) => {
    expect(parseRecipient(addr, DOMAIN)).toBeNull();
  });
  it('refuses non-strings', () => {
    for (const v of [undefined, null, 5, {}, ['a']]) expect(parseRecipient(v, DOMAIN)).toBeNull();
  });
});
