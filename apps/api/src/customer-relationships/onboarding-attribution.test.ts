import { describe, expect, it } from 'vitest';
import { sign } from 'hono/jwt';
import { signAccessToken } from '../auth/jwt';
import {
  ONBOARDING_INVITE_TTL_SECONDS,
  signOnboardingInvite,
  verifyOnboardingInvite,
} from './onboarding-attribution';

const SECRET = 'unit-invite-secret';
const input = {
  cashierUserId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  businessId: '33333333-3333-4333-8333-333333333333',
  branchId: '44444444-4444-4444-8444-444444444444',
};

describe('onboarding invitation token (CASHIER-AUTH-02D)', () => {
  it('round-trips exactly the server-set claims and expires after the short TTL', async () => {
    const { token, inviteId, expiresAt } = await signOnboardingInvite(input, SECRET);
    const claims = await verifyOnboardingInvite(token, SECRET);
    expect(claims).toMatchObject({ ...input, inviteId });
    expect(claims.expiresAt.getTime()).toBe(expiresAt.getTime());
    const ttl = (expiresAt.getTime() - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(ONBOARDING_INVITE_TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(ONBOARDING_INVITE_TTL_SECONDS);
    expect(ONBOARDING_INVITE_TTL_SECONDS).toBeLessThanOrEqual(10 * 60);
  });

  it('every invitation has its own identity (the one-time key)', async () => {
    const a = await signOnboardingInvite(input, SECRET);
    const b = await signOnboardingInvite(input, SECRET);
    expect(a.inviteId).not.toBe(b.inviteId);
  });

  it('refuses a wrong secret, a tampered token, garbage and an expired token with the same generic error', async () => {
    const { token } = await signOnboardingInvite(input, SECRET);
    const expired = await sign({ sub: input.cashierUserId, type: 'onboarding_invite', sid: input.sessionId, biz: input.businessId, brid: input.branchId, jti: 'x', iat: 1, exp: 2 }, SECRET, 'HS256');
    for (const bad of [token.slice(0, -3) + 'abc', 'x.y.z', '', expired]) {
      await expect(verifyOnboardingInvite(bad, SECRET)).rejects.toMatchObject({ status: 400, code: 'ONBOARDING_INVITE_INVALID' });
    }
    await expect(verifyOnboardingInvite(token, 'another-secret')).rejects.toMatchObject({ code: 'ONBOARDING_INVITE_INVALID' });
  });

  it('is not interchangeable with an access token in either direction', async () => {
    const access = await signAccessToken(input.cashierUserId, SECRET);
    await expect(verifyOnboardingInvite(access, SECRET)).rejects.toMatchObject({ code: 'ONBOARDING_INVITE_INVALID' });
    const { token } = await signOnboardingInvite(input, SECRET);
    const { verifyAccessToken } = await import('../auth/jwt');
    await expect(verifyAccessToken(token, SECRET)).rejects.toThrow();
  });

  it('refuses a token missing any identity claim (it could not be bound to a session, branch or one-time use)', async () => {
    const base = { sub: input.cashierUserId, type: 'onboarding_invite', sid: input.sessionId, biz: input.businessId, brid: input.branchId, jti: 'j', iat: 1, exp: Math.floor(Date.now() / 1000) + 600 };
    for (const drop of ['sub', 'sid', 'biz', 'brid', 'jti', 'exp'] as const) {
      const { [drop]: _omitted, ...partial } = base;
      void _omitted;
      await expect(verifyOnboardingInvite(await sign(partial, SECRET, 'HS256'), SECRET)).rejects.toMatchObject({ code: 'ONBOARDING_INVITE_INVALID' });
    }
  });
});
