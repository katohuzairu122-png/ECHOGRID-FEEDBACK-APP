import { describe, it, expect } from 'vitest';
import { sign } from 'hono/jwt';
import {
  CUSTOMER_SESSION_ACCESS_TTL_SECONDS,
  CUSTOMER_SESSION_AUDIENCE,
  CUSTOMER_SESSION_ISSUER,
  generateRefreshCredential,
  hashRefreshCredential,
  isWellFormedRefreshCredential,
  routeBearerToken,
  signCustomerSessionAccessToken,
  verifyCustomerSessionAccessToken,
} from './session-tokens';
import { signCustomerAccessToken, verifyCustomerAccessToken } from './customer-jwt';
import { signAccessToken } from '../auth/jwt';
import { signCustomerQrToken } from '../qr/customer-qr-token';

const SECRET = 'customer-session-test-secret-do-not-use-in-production';
const OTHER_SECRET = 'a-different-secret';
const CUSTOMER_ID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const SESSION_ID = '8a1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f';

describe('customer session access tokens', () => {
  it('round-trips sub, sid, type, issuer and audience', async () => {
    const token = await signCustomerSessionAccessToken(CUSTOMER_ID, SESSION_ID, SECRET);
    const payload = await verifyCustomerSessionAccessToken(token, SECRET);
    expect(payload).toMatchObject({
      sub: CUSTOMER_ID,
      sid: SESSION_ID,
      type: 'customer_session_access',
      iss: CUSTOMER_SESSION_ISSUER,
      aud: CUSTOMER_SESSION_AUDIENCE,
    });
  });

  it('defaults to the proposed 15 minute lifetime and accepts an override', async () => {
    const now = Math.floor(Date.now() / 1000);
    const def = await verifyCustomerSessionAccessToken(
      await signCustomerSessionAccessToken(CUSTOMER_ID, SESSION_ID, SECRET, { nowSeconds: now }),
      SECRET,
    );
    expect(def.exp - def.iat).toBe(CUSTOMER_SESSION_ACCESS_TTL_SECONDS);
    const short = await verifyCustomerSessionAccessToken(
      await signCustomerSessionAccessToken(CUSTOMER_ID, SESSION_ID, SECRET, {
        nowSeconds: now,
        ttlSeconds: 60,
      }),
      SECRET,
    );
    expect(short.exp - short.iat).toBe(60);
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await signCustomerSessionAccessToken(CUSTOMER_ID, SESSION_ID, SECRET, {
      nowSeconds: past,
      ttlSeconds: 60,
    });
    await expect(verifyCustomerSessionAccessToken(token, SECRET)).rejects.toThrow();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signCustomerSessionAccessToken(CUSTOMER_ID, SESSION_ID, SECRET);
    await expect(verifyCustomerSessionAccessToken(token, OTHER_SECRET)).rejects.toThrow();
  });

  it('refuses to sign or verify with an empty secret', async () => {
    await expect(signCustomerSessionAccessToken(CUSTOMER_ID, SESSION_ID, '')).rejects.toThrow();
    await expect(verifyCustomerSessionAccessToken('a.b.c', '')).rejects.toThrow();
  });

  it('refuses to sign with a malformed customer id, session id or lifetime', async () => {
    await expect(
      signCustomerSessionAccessToken('not-a-uuid', SESSION_ID, SECRET),
    ).rejects.toThrow();
    await expect(
      signCustomerSessionAccessToken(CUSTOMER_ID, 'not-a-uuid', SECRET),
    ).rejects.toThrow();
    await expect(
      signCustomerSessionAccessToken(CUSTOMER_ID, SESSION_ID, SECRET, { ttlSeconds: 0 }),
    ).rejects.toThrow();
    await expect(
      signCustomerSessionAccessToken(CUSTOMER_ID, SESSION_ID, SECRET, { ttlSeconds: 1.5 }),
    ).rejects.toThrow();
  });

  it('rejects an HS512 token signed with the same secret (algorithm is pinned)', async () => {
    const iat = Math.floor(Date.now() / 1000);
    const token = await sign(
      {
        sub: CUSTOMER_ID,
        sid: SESSION_ID,
        type: 'customer_session_access',
        iss: CUSTOMER_SESSION_ISSUER,
        aud: CUSTOMER_SESSION_AUDIENCE,
        iat,
        exp: iat + 600,
      },
      SECRET,
      'HS512',
    );
    await expect(verifyCustomerSessionAccessToken(token, SECRET)).rejects.toThrow();
  });

  describe('cross-domain isolation (same secret on purpose, to prove the claims alone protect us)', () => {
    it('rejects the legacy 90-day customer token', async () => {
      const legacy = await signCustomerAccessToken(CUSTOMER_ID, SECRET);
      await expect(verifyCustomerSessionAccessToken(legacy, SECRET)).rejects.toThrow();
    });

    it('rejects a staff access token', async () => {
      const staff = await signAccessToken(CUSTOMER_ID, SECRET, SESSION_ID);
      await expect(verifyCustomerSessionAccessToken(staff, SECRET)).rejects.toThrow();
    });

    it('rejects the 5 minute customer QR token', async () => {
      const qr = await signCustomerQrToken(CUSTOMER_ID, SECRET);
      await expect(verifyCustomerSessionAccessToken(qr, SECRET)).rejects.toThrow();
    });

    it('the legacy verifier does not accept a session token either', async () => {
      const token = await signCustomerSessionAccessToken(CUSTOMER_ID, SESSION_ID, SECRET);
      await expect(verifyCustomerAccessToken(token, SECRET)).rejects.toThrow();
    });
  });

  describe('claim validation', () => {
    const iat = Math.floor(Date.now() / 1000);
    const good = {
      sub: CUSTOMER_ID,
      sid: SESSION_ID,
      type: 'customer_session_access',
      iss: CUSTOMER_SESSION_ISSUER,
      aud: CUSTOMER_SESSION_AUDIENCE,
      iat,
      exp: iat + 600,
    };
    const signRaw = (over: Record<string, unknown>) => sign({ ...good, ...over }, SECRET, 'HS256');

    it('accepts the well-formed baseline used by the cases below', async () => {
      await expect(
        verifyCustomerSessionAccessToken(await signRaw({}), SECRET),
      ).resolves.toBeTruthy();
    });

    it.each([
      ['wrong issuer', { iss: 'someone-else' }],
      ['missing issuer', { iss: undefined }],
      ['wrong audience', { aud: 'echogrid-staff-api' }],
      ['missing audience', { aud: undefined }],
      ['wrong type', { type: 'customer_access' }],
      ['missing sid', { sid: undefined }],
      ['non-uuid sid', { sid: 'abc' }],
      ['non-uuid sub', { sub: 'abc' }],
      ['numeric sub', { sub: 12345 }],
    ])('rejects %s', async (_label, over) => {
      await expect(verifyCustomerSessionAccessToken(await signRaw(over), SECRET)).rejects.toThrow();
    });
  });

  it('rejects garbage input without throwing anything but an error', async () => {
    for (const value of ['', 'abc', 'a.b.c', '....', 'x'.repeat(10_000)]) {
      await expect(verifyCustomerSessionAccessToken(value, SECRET)).rejects.toThrow();
    }
  });
});

describe('routeBearerToken (an untrusted routing hint, never an authorization)', () => {
  it('routes by the unverified type claim', async () => {
    expect(
      routeBearerToken(await signCustomerSessionAccessToken(CUSTOMER_ID, SESSION_ID, SECRET)),
    ).toBe('session');
    expect(routeBearerToken(await signCustomerAccessToken(CUSTOMER_ID, SECRET))).toBe('legacy');
    expect(routeBearerToken(await signAccessToken(CUSTOMER_ID, SECRET))).toBe('unknown');
  });

  it('returns unknown for malformed input', () => {
    for (const value of ['', 'abc', 'a.b.c', '....'])
      expect(routeBearerToken(value)).toBe('unknown');
  });

  it('a forged token that CLAIMS to be a session token routes as session but never verifies', async () => {
    const forged = await signCustomerSessionAccessToken(CUSTOMER_ID, SESSION_ID, OTHER_SECRET);
    expect(routeBearerToken(forged)).toBe('session');
    await expect(verifyCustomerSessionAccessToken(forged, SECRET)).rejects.toThrow();
  });
});

describe('refresh credentials', () => {
  it('generates 43 character base64url values that are well formed and unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const credential = generateRefreshCredential();
      expect(credential).toHaveLength(43);
      expect(isWellFormedRefreshCredential(credential)).toBe(true);
      seen.add(credential);
    }
    expect(seen.size).toBe(200);
  });

  it('hashes deterministically to 64 hex characters and differs per credential', async () => {
    const a = generateRefreshCredential();
    const b = generateRefreshCredential();
    const hashA = await hashRefreshCredential(a);
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashRefreshCredential(a)).toBe(hashA);
    expect(await hashRefreshCredential(b)).not.toBe(hashA);
  });

  it('never returns the credential inside its hash', async () => {
    const credential = generateRefreshCredential();
    expect(await hashRefreshCredential(credential)).not.toContain(credential);
  });

  it.each([
    [''],
    ['short'],
    ['a'.repeat(42)],
    ['a'.repeat(44)],
    ['a'.repeat(43) + '='],
    ['a'.repeat(42) + '+'],
    ['a'.repeat(42) + ' '],
    ['a'.repeat(1_000_000)],
  ])('rejects a malformed credential without hashing it (%#)', async (value) => {
    expect(isWellFormedRefreshCredential(value)).toBe(false);
    await expect(hashRefreshCredential(value)).rejects.toThrow();
  });

  it('rejects non-strings', () => {
    for (const value of [undefined, null, 42, {}, ['a']]) {
      expect(isWellFormedRefreshCredential(value)).toBe(false);
    }
  });
});
