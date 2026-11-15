import { describe, expect, it, vi } from 'vitest';
import { sign } from 'hono/jwt';
import { randomUUID } from 'node:crypto';
import { signAccessToken, signCashierAccessToken } from './jwt';
import { TrustedBrokerAssertionIssuer } from './trusted-broker-issuer';

/**
 * SEC-CASHIER-POST-R2 C2 (runs everywhere, no PostgreSQL): a cashier-scoped token is a limited credential and is never
 * broker authority. The refusal happens at token verification, BEFORE any database work, and is exact (the `client`
 * claim alone), so it cannot be bypassed by a valid session, membership or permission.
 */
const SECRET = 'broker-cashier-test-secret-not-real-0123456789';
const ACTOR = randomUUID();
const SESSION = randomUUID();
const BUSINESS = randomUUID();
const BRANCH = randomUUID();

function issuer() {
  const transaction = vi.fn(async () => {
    throw new Error('DATABASE_TOUCHED');
  });
  const signer = { keyId: 'k', sign: vi.fn(async () => new Uint8Array(64)) };
  const subject = new TrustedBrokerAssertionIssuer({
    db: { transaction } as never,
    accessSecret: SECRET,
    keys: async () => undefined as never,
    signer,
  });
  return { subject, transaction, signer };
}
const request = (authorization: string) => ({ authorization, businessId: BUSINESS, branchId: BRANCH, operation: 'branches:read' as const });

describe('trusted broker issuer refuses cashier-scoped tokens', () => {
  it('denies a genuine cashier token with AUTHENTICATION_DENIED before touching the database or signing', async () => {
    const { subject, transaction, signer } = issuer();
    const token = await signCashierAccessToken(ACTOR, SECRET, { sessionId: SESSION, businessId: BUSINESS, branchId: BRANCH });
    expect(await subject.issue(request(`Bearer ${token}`))).toMatchObject({ ok: false, reason: 'AUTHENTICATION_DENIED' });
    expect(transaction).not.toHaveBeenCalled();
    expect(signer.sign).not.toHaveBeenCalled();
  });
  it('denies a cashier token for a wide (no-branch) binding too', async () => {
    const { subject, transaction } = issuer();
    const token = await signCashierAccessToken(ACTOR, SECRET, { sessionId: SESSION, businessId: BUSINESS });
    expect(await subject.issue(request(`Bearer ${token}`))).toMatchObject({ ok: false, reason: 'AUTHENTICATION_DENIED' });
    expect(transaction).not.toHaveBeenCalled();
  });
  it('control: an ordinary access token for the same session passes the token stage and proceeds to the database', async () => {
    const { subject, transaction } = issuer();
    const token = await signAccessToken(ACTOR, SECRET, SESSION);
    const result = await subject.issue(request(`Bearer ${token}`));
    // The fake database throws; the issuer fails closed (no issuance), but it DID reach the database, which the cashier token never does.
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });
  it('a hand-made token carrying any client claim is denied (exact claim check, not a role of the signer)', async () => {
    const { subject, transaction } = issuer();
    const t = Math.floor(Date.now() / 1000);
    const forged = await sign({ sub: ACTOR, sid: SESSION, type: 'access', client: 'cashier', bid: BUSINESS, iat: t - 10, exp: t + 600 }, SECRET, 'HS256');
    expect(await subject.issue(request(`Bearer ${forged}`))).toMatchObject({ ok: false, reason: 'AUTHENTICATION_DENIED' });
    expect(transaction).not.toHaveBeenCalled();
  });
});
