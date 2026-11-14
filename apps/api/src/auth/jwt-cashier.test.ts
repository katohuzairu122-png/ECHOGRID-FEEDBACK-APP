import { describe, it, expect } from 'vitest';
import { sign } from 'hono/jwt';
import {
  signAccessToken,
  signCashierAccessToken,
  signImpersonationToken,
  verifyAccessToken,
  verifyCashierAccessToken,
} from './jwt';

const SECRET = 'cashier-c2-test-secret-not-real';
const USER = '11111111-1111-4111-8111-111111111111';
const BUSINESS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRANCH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SESSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const now = () => Math.floor(Date.now() / 1000);
/** Signs an arbitrary payload with the real secret, to build tokens the signer refuses to produce. */
const forge = (extra: Record<string, unknown>, secret = SECRET) =>
  sign({ sub: USER, type: 'access', iat: now(), exp: now() + 600, ...extra }, secret, 'HS256');

describe('cashier access token contract', () => {
  it('signs and verifies a cashier token bound to a business and branch', async () => {
    const token = await signCashierAccessToken(USER, SECRET, {
      sessionId: SESSION,
      businessId: BUSINESS,
      branchId: BRANCH,
    });
    const payload = await verifyCashierAccessToken(token, SECRET);
    expect(payload).toMatchObject({
      sub: USER,
      type: 'access',
      client: 'cashier',
      bid: BUSINESS,
      brid: BRANCH,
      sid: SESSION,
    });
    expect(payload.impersonatedBy).toBeUndefined();
  });

  it('allows a business-wide binding with no branch', async () => {
    const token = await signCashierAccessToken(USER, SECRET, {
      sessionId: SESSION,
      businessId: BUSINESS,
    });
    const payload = await verifyCashierAccessToken(token, SECRET);
    expect(payload.brid).toBeUndefined();
  });

  it('refuses to sign a malformed session, business or branch id', async () => {
    await expect(
      signCashierAccessToken(USER, SECRET, { sessionId: 'nope', businessId: BUSINESS }),
    ).rejects.toThrow();
    await expect(
      signCashierAccessToken(USER, SECRET, { sessionId: SESSION, businessId: 'nope' }),
    ).rejects.toThrow();
    await expect(
      signCashierAccessToken(USER, SECRET, {
        sessionId: SESSION,
        businessId: BUSINESS,
        branchId: 'nope',
      }),
    ).rejects.toThrow();
  });

  it('keeps the normal verifier accepting a cashier token as a staff identity only through the scope rules', async () => {
    const token = await signCashierAccessToken(USER, SECRET, {
      sessionId: SESSION,
      businessId: BUSINESS,
    });
    // verifyAccessToken still verifies it (the allow-list, not the verifier, restricts where it can be used).
    expect((await verifyAccessToken(token, SECRET)).client).toBe('cashier');
  });

  it('refuses an ordinary admin token where a cashier token is required', async () => {
    const admin = await signAccessToken(USER, SECRET, SESSION);
    await expect(verifyCashierAccessToken(admin, SECRET)).rejects.toThrow('Not a cashier token');
  });

  it('refuses an ordinary token that carries binding claims without a client', async () => {
    await expect(
      verifyAccessToken(await forge({ bid: BUSINESS, sid: SESSION }), SECRET),
    ).rejects.toThrow();
    await expect(
      verifyAccessToken(await forge({ brid: BRANCH, sid: SESSION }), SECRET),
    ).rejects.toThrow();
  });

  it('refuses a cashier token with an unknown client, no business, malformed ids or no session', async () => {
    await expect(
      verifyAccessToken(await forge({ client: 'kiosk', bid: BUSINESS, sid: SESSION }), SECRET),
    ).rejects.toThrow();
    await expect(
      verifyAccessToken(await forge({ client: 'cashier', sid: SESSION }), SECRET),
    ).rejects.toThrow();
    await expect(
      verifyAccessToken(
        await forge({ client: 'cashier', bid: 'not-a-uuid', sid: SESSION }),
        SECRET,
      ),
    ).rejects.toThrow();
    await expect(
      verifyAccessToken(
        await forge({ client: 'cashier', bid: BUSINESS, brid: 'x', sid: SESSION }),
        SECRET,
      ),
    ).rejects.toThrow();
    await expect(
      verifyAccessToken(await forge({ client: 'cashier', bid: BUSINESS }), SECRET),
    ).rejects.toThrow();
  });

  it('refuses a cashier token that is also an impersonation token', async () => {
    await expect(
      verifyAccessToken(
        await forge({ client: 'cashier', bid: BUSINESS, sid: SESSION, impersonatedBy: USER }),
        SECRET,
      ),
    ).rejects.toThrow();
    // A genuine impersonation token still verifies as an ordinary (unscoped) token and is not a cashier token.
    const { token } = await signImpersonationToken(
      USER,
      '22222222-2222-4222-8222-222222222222',
      SECRET,
    );
    await expect(verifyCashierAccessToken(token, SECRET)).rejects.toThrow('Not a cashier token');
  });

  it('refuses expired, wrongly signed and malformed cashier tokens', async () => {
    const expired = await sign(
      {
        sub: USER,
        type: 'access',
        client: 'cashier',
        bid: BUSINESS,
        sid: SESSION,
        iat: now() - 2000,
        exp: now() - 1000,
      },
      SECRET,
      'HS256',
    );
    await expect(verifyCashierAccessToken(expired, SECRET)).rejects.toThrow();
    const wrong = await signCashierAccessToken(USER, 'a-different-secret', {
      sessionId: SESSION,
      businessId: BUSINESS,
    });
    await expect(verifyCashierAccessToken(wrong, SECRET)).rejects.toThrow();
    await expect(verifyCashierAccessToken('not.a.token', SECRET)).rejects.toThrow();
    await expect(verifyCashierAccessToken('garbage', SECRET)).rejects.toThrow();
  });

  it('does not change ordinary tokens', async () => {
    const token = await signAccessToken(USER, SECRET, SESSION);
    const payload = await verifyAccessToken(token, SECRET);
    expect(payload.client).toBeUndefined();
    expect(payload.bid).toBeUndefined();
    expect(payload.sid).toBe(SESSION);
  });
});
