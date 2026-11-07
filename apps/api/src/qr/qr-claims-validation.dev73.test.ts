import { describe, expect, it } from 'vitest';
import { sign } from 'hono/jwt';
import { validBusinessQrClaims, validCustomerQrClaims } from './qr-claims-validation';
import { verifyQrToken, signQrToken } from './qr-token';
import { verifyCustomerQrToken, signCustomerQrToken } from './customer-qr-token';

const SECRET = 'dev73-qr-claim-verification-secret';
const NEXT_SECRET = 'dev73-next-qr-verification-secret';
const now = Math.floor(Date.now() / 1000);
const businessClaims = {
  sub: 'qr-code-a',
  businessId: 'business-a',
  branchId: 'branch-a',
  campaignId: null,
  type: 'qr_business',
  sigVer: 1,
  nonce: 'nonce-a',
  iat: now,
  exp: now + 60,
};
const customerClaims = {
  sub: 'customer-a',
  type: 'qr_customer',
  sigVer: 1,
  nonce: 'nonce-b',
  iat: now,
  exp: now + 60,
};

describe('DEV-73 business QR signed-claim integrity', () => {
  it('preserves current issued tokens, the legacy feedback type and previous signing secret', async () => {
    const token = await signQrToken({
      qrCodeId: 'qr-code-a', businessId: 'business-a', branchId: 'branch-a',
    }, SECRET);
    await expect(verifyQrToken(token, SECRET)).resolves.toMatchObject({
      sub: 'qr-code-a', businessId: 'business-a', branchId: 'branch-a',
    });
    const legacy = await sign({ ...businessClaims, type: 'qr_feedback' }, SECRET, 'HS256');
    await expect(verifyQrToken(legacy, NEXT_SECRET, SECRET)).resolves.toMatchObject({
      type: 'qr_feedback', sub: 'qr-code-a',
    });
  });

  it.each([
    { name: 'missing QR subject', changes: { sub: undefined } },
    { name: 'noncanonical business identity', changes: { businessId: '../business-a' } },
    { name: 'missing branch', changes: { branchId: undefined } },
    { name: 'malformed campaign reference', changes: { campaignId: { id: 'campaign-a' } } },
    { name: 'unsupported signature version', changes: { sigVer: 2 } },
    { name: 'blank nonce', changes: { nonce: '' } },
  ])('denies correctly signed claims with $name', async ({ changes }) => {
    const malformed = { ...businessClaims, ...changes };
    expect(validBusinessQrClaims(malformed, 1)).toBe(false);
    const token = await sign(malformed, SECRET, 'HS256');
    await expect(verifyQrToken(token, SECRET)).rejects.toThrow();
  });

  it.each([
    { iat: 0, exp: now + 60 },
    { iat: now + 61, exp: now + 60 },
    { iat: 1.5, exp: now + 60 },
    { iat: now, exp: now + 0.5 },
    { iat: now, exp: Number.POSITIVE_INFINITY },
  ])('rejects missing, unsafe or inverted time claims %#', claims => {
    expect(validBusinessQrClaims({ ...businessClaims, ...claims }, 1)).toBe(false);
  });

  it('rejects an unrelated customer QR purpose', async () => {
    const token = await sign({ ...customerClaims, type: 'qr_customer' }, SECRET, 'HS256');
    await expect(verifyQrToken(token, SECRET)).rejects.toThrow();
  });
});

describe('DEV-73 customer QR signed-claim integrity', () => {
  it('accepts issued customer tokens including a previous-secret rotation window', async () => {
    const token = await signCustomerQrToken('customer-a', SECRET);
    await expect(verifyCustomerQrToken(token, NEXT_SECRET, SECRET)).resolves.toMatchObject({
      sub: 'customer-a', type: 'qr_customer', sigVer: 1,
    });
  });

  it.each([
    { name: 'missing identity', changes: { sub: undefined } },
    { name: 'malformed customer identity', changes: { sub: '../customer' } },
    { name: 'unrecognized version', changes: { sigVer: 99 } },
    { name: 'missing nonce', changes: { nonce: undefined } },
    { name: 'empty nonce', changes: { nonce: '' } },
    { name: 'incorrect token type', changes: { type: 'qr_business' } },
  ])('denies a signed customer QR with $name', async ({ changes }) => {
    const malformed = { ...customerClaims, ...changes };
    expect(validCustomerQrClaims(malformed, 1)).toBe(false);
    const token = await sign(malformed, SECRET, 'HS256');
    await expect(verifyCustomerQrToken(token, SECRET)).rejects.toThrow();
  });

  it('rejects non-integral or inverted claim times without trusting JWT type casts', () => {
    expect(validCustomerQrClaims({ ...customerClaims, iat: 'now' }, 1)).toBe(false);
    expect(validCustomerQrClaims({ ...customerClaims, exp: now - 1 }, 1)).toBe(false);
  });
});
