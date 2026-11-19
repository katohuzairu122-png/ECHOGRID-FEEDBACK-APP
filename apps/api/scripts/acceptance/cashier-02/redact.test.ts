import { describe, expect, it } from 'vitest';
import { findSecretLeaks, redactString, redactValue } from './redact';

const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abcdefghijklmnopqrstuvwxyz012345';
const sample = `token ${jwt} Bearer abcdef.ghijkl-mnop user.name@example.com +1 559 123 4567 code 123456 id 8142403d-073a-4ff9-9d4d-4f7a07b5c550 opaque ${'a'.repeat(40)}`;

describe('redaction', () => {
  it('removes every kind of sensitive material from free text', () => {
    const out = redactString(sample);
    expect(findSecretLeaks(out)).toEqual([]);
    expect(out).not.toContain('user.name@example.com');
    expect(out).not.toContain('123456');
    expect(out).not.toContain('8142403d');
    expect(out).toContain('[jwt]');
  });
  it('keeps identifiers correlatable through a stable short hash', () => {
    expect(redactString('a@b.co and a@b.co')).toMatch(/\[email:([0-9a-f]{8})\] and \[email:\1\]/);
    expect(redactString('8142403d-073a-4ff9-9d4d-4f7a07b5c550')).toBe(redactString('8142403D-073A-4FF9-9D4D-4F7A07B5C550'));
  });
  it('keeps ordinary diagnostic text readable', () => {
    expect(redactString('403 CASHIER_CONTEXT_MISMATCH 1450 passed')).toBe('403 CASHIER_CONTEXT_MISMATCH 1450 passed');
  });
  it('redacts by key name in objects, at any depth', () => {
    const out = redactValue({ ok: 1, password: 'p', nested: { accessToken: 't', refreshToken: 'r', otp: '123456', inviteUrl: 'https://x', list: [{ code: '123456', note: 'a@b.co' }] } }) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toContain('"p"');
    expect(findSecretLeaks(text)).toEqual([]);
    expect(text).toContain('[redacted]');
  });
  it('the leak detector names kinds, never the material', () => {
    expect(findSecretLeaks(sample).sort()).toEqual(['bearer', 'email', 'jwt', 'opaque', 'otp', 'phone', 'uuid'].sort());
    expect(findSecretLeaks('nothing sensitive here')).toEqual([]);
  });
});
