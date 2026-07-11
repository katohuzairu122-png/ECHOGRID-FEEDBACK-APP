import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('produces a self-describing pbkdf2 hash at the current iteration count', async () => {
    const hash = await hashPassword('correct horse battery staple');
    const parts = hash.split('$');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('pbkdf2');
    expect(Number(parts[1])).toBeGreaterThanOrEqual(600_000);
  });

  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('wrong password', hash)).resolves.toBe(false);
  });

  it('produces a different hash for the same input each time (random salt)', async () => {
    const a = await hashPassword('same input');
    const b = await hashPassword('same input');
    expect(a).not.toBe(b);
    await expect(verifyPassword('same input', a)).resolves.toBe(true);
    await expect(verifyPassword('same input', b)).resolves.toBe(true);
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    await expect(verifyPassword('anything', 'not-a-real-hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', '')).resolves.toBe(false);
  });

  it('fails gracefully, not by throwing, if the embedded iteration count is tampered with', async () => {
    const hash = await hashPassword('some password');
    const [, , salt, digest] = hash.split('$');
    const tampered = `pbkdf2$100000$${salt}$${digest}`;
    await expect(verifyPassword('some password', tampered)).resolves.toBe(false);
  });
});
