import { describe, expect, it } from 'vitest';
import { sealPendingRegistration, unsealPendingRegistration } from './customer-registration-seal';

const secret = 'pending-registration-synthetic-secret-is-long-enough';
const subjectDigest = 'a'.repeat(64);
const proofDigest = 'b'.repeat(64);
const record = {
  email: 'customer@example.test',
  name: 'Synthetic Customer',
  passwordHash: 'pbkdf2$100000$synthetic-salt$synthetic-hash',
};

describe('challenge-bound encrypted pending registration', () => {
  it('encrypts and decrypts a validated signup without exposing any direct identifier or hash', async () => {
    const sealed = await sealPendingRegistration({ secret, subjectDigest, proofDigest, record });
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    for (const privateValue of Object.values(record)) expect(sealed).not.toContain(privateValue);
    expect(await unsealPendingRegistration({ secret, subjectDigest, proofDigest, sealed })).toEqual(record);
  });

  it('uses a random nonce for each issuance', async () => {
    const first = await sealPendingRegistration({ secret, subjectDigest, proofDigest, record });
    const second = await sealPendingRegistration({ secret, subjectDigest, proofDigest, record });
    expect(first).not.toEqual(second);
  });

  it('rejects swapped email subjects, proofs, tampering and the wrong key', async () => {
    const sealed = await sealPendingRegistration({ secret, subjectDigest, proofDigest, record });
    for (const override of [
      { subjectDigest: 'c'.repeat(64) }, { proofDigest: 'd'.repeat(64) }, { secret: secret + '-wrong' },
      { sealed: sealed.slice(0, -1) + (sealed.endsWith('A') ? 'B' : 'A') },
    ]) {
      expect(await unsealPendingRegistration({ secret, subjectDigest, proofDigest, sealed, ...override })).toBeNull();
    }
  });

  it('refuses malformed payload and invalid hash or normalized email', async () => {
    expect(await unsealPendingRegistration({ secret, subjectDigest, proofDigest, sealed: 'v1.invalid' })).toBeNull();
    await expect(sealPendingRegistration({ secret, subjectDigest, proofDigest, record: { ...record, email: 'UPPER@example.test' } })).rejects.toThrow();
    await expect(sealPendingRegistration({ secret, subjectDigest, proofDigest, record: { ...record, passwordHash: 'plaintext' } })).rejects.toThrow();
  });
});
