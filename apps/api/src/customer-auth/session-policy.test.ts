import { describe, it, expect } from 'vitest';
import {
  CUSTOMER_REFRESH_CONCURRENCY_GRACE_MS,
  computeSessionExpiries,
  customerMayHaveSession,
  evaluateLegacyToken,
  evaluatePasswordEnrollment,
  evaluateRefresh,
  isStepUpFresh,
  nextIdleExpiry,
  sessionLiveness,
  type CustomerGate,
  type RefreshTokenTimes,
  type SessionTimes,
} from './session-policy';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

const activeCustomer: CustomerGate = { status: 'active', isDeleted: false };
const liveSession: SessionTimes = {
  revokedAt: null,
  absoluteExpiresAt: at(10 * DAY),
  idleExpiresAt: at(5 * DAY),
};
const freshToken: RefreshTokenTimes = { expiresAt: at(10 * DAY), rotatedAt: null, revokedAt: null };

describe('customerMayHaveSession', () => {
  it('allows only active, not-deleted customers', () => {
    expect(customerMayHaveSession(activeCustomer)).toBe(true);
    expect(customerMayHaveSession({ status: 'suspended', isDeleted: false })).toBe(false);
    expect(customerMayHaveSession({ status: 'active', isDeleted: true })).toBe(false);
    expect(customerMayHaveSession({ status: 'unknown', isDeleted: false })).toBe(false);
  });
});

describe('sessionLiveness', () => {
  it('is live before both expiries and not revoked', () => {
    expect(sessionLiveness(liveSession, NOW)).toEqual({ live: true });
  });

  it('is dead once revoked, even if unexpired (revocation is final)', () => {
    expect(sessionLiveness({ ...liveSession, revokedAt: at(-1) }, NOW)).toEqual({
      live: false,
      reason: 'revoked',
    });
  });

  it('treats the expiry instant itself as dead (strictly before)', () => {
    expect(sessionLiveness({ ...liveSession, absoluteExpiresAt: NOW }, NOW)).toEqual({
      live: false,
      reason: 'absolute_expired',
    });
    expect(sessionLiveness({ ...liveSession, idleExpiresAt: NOW }, NOW)).toEqual({
      live: false,
      reason: 'idle_expired',
    });
    expect(sessionLiveness({ ...liveSession, idleExpiresAt: at(1) }, NOW)).toEqual({ live: true });
  });

  it('reports revoked before expiry reasons, and absolute before idle', () => {
    const allDead: SessionTimes = {
      revokedAt: at(-5),
      absoluteExpiresAt: at(-3),
      idleExpiresAt: at(-1),
    };
    expect(sessionLiveness(allDead, NOW)).toEqual({ live: false, reason: 'revoked' });
    expect(sessionLiveness({ ...allDead, revokedAt: null }, NOW)).toEqual({
      live: false,
      reason: 'absolute_expired',
    });
  });
});

describe('session expiries', () => {
  it('computes absolute and idle from now', () => {
    const result = computeSessionExpiries(NOW, {
      absoluteSeconds: 30 * 86400,
      idleSeconds: 7 * 86400,
    });
    expect(result.absoluteExpiresAt).toEqual(at(30 * DAY));
    expect(result.idleExpiresAt).toEqual(at(7 * DAY));
  });

  it('never lets the idle expiry exceed the absolute cap', () => {
    const result = computeSessionExpiries(NOW, { absoluteSeconds: 3600, idleSeconds: 86400 });
    expect(result.idleExpiresAt).toEqual(result.absoluteExpiresAt);
  });

  it('moves the idle window forward on refresh but clamps to the absolute cap', () => {
    expect(nextIdleExpiry(NOW, 3600, at(DAY))).toEqual(at(60 * MINUTE));
    expect(nextIdleExpiry(NOW, 2 * 86400, at(DAY))).toEqual(at(DAY));
  });

  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'rejects invalid limit %s',
    (bad) => {
      expect(() =>
        computeSessionExpiries(NOW, { absoluteSeconds: bad, idleSeconds: 60 }),
      ).toThrow();
      expect(() =>
        computeSessionExpiries(NOW, { absoluteSeconds: 60, idleSeconds: bad }),
      ).toThrow();
      expect(() => nextIdleExpiry(NOW, bad, at(DAY))).toThrow();
    },
  );
});

describe('evaluateRefresh', () => {
  const decide = (over: Partial<Parameters<typeof evaluateRefresh>[0]> = {}) =>
    evaluateRefresh({
      token: freshToken,
      session: liveSession,
      customer: activeCustomer,
      now: NOW,
      ...over,
    });

  it('rotates a usable, unused token on a live session', () => {
    expect(decide()).toEqual({ kind: 'rotate' });
  });

  it('rejects when the session is revoked or expired, reporting the session reason', () => {
    expect(decide({ session: { ...liveSession, revokedAt: at(-1) } })).toEqual({
      kind: 'reject',
      reason: 'revoked',
    });
    expect(decide({ session: { ...liveSession, absoluteExpiresAt: at(-1) } })).toEqual({
      kind: 'reject',
      reason: 'absolute_expired',
    });
    expect(decide({ session: { ...liveSession, idleExpiresAt: at(-1) } })).toEqual({
      kind: 'reject',
      reason: 'idle_expired',
    });
  });

  it('rejects a suspended or soft-deleted customer even with a perfect token (01B I7)', () => {
    expect(decide({ customer: { status: 'suspended', isDeleted: false } })).toEqual({
      kind: 'reject',
      reason: 'customer_inactive',
    });
    expect(decide({ customer: { status: 'active', isDeleted: true } })).toEqual({
      kind: 'reject',
      reason: 'customer_inactive',
    });
  });

  it('rejects a revoked token and an expired token', () => {
    expect(decide({ token: { ...freshToken, revokedAt: at(-1) } })).toEqual({
      kind: 'reject',
      reason: 'token_revoked',
    });
    expect(decide({ token: { ...freshToken, expiresAt: at(-1) } })).toEqual({
      kind: 'reject',
      reason: 'token_expired',
    });
    expect(decide({ token: { ...freshToken, expiresAt: NOW } })).toEqual({
      kind: 'reject',
      reason: 'token_expired',
    });
  });

  describe('replay detection (01B I3 and I4)', () => {
    it('a token rotated inside the grace window is a concurrent request: retryable, NOT a replay', () => {
      const token = { ...freshToken, rotatedAt: at(-2 * SECOND) };
      expect(decide({ token })).toEqual({ kind: 'concurrent_rotation' });
    });

    it('the grace boundary is inclusive', () => {
      const token = { ...freshToken, rotatedAt: at(-CUSTOMER_REFRESH_CONCURRENCY_GRACE_MS) };
      expect(decide({ token })).toEqual({ kind: 'concurrent_rotation' });
      expect(
        decide({
          token: { ...freshToken, rotatedAt: at(-CUSTOMER_REFRESH_CONCURRENCY_GRACE_MS - 1) },
        }),
      ).toEqual({
        kind: 'replay',
      });
    });

    it('a token rotated outside the grace window is replay', () => {
      expect(decide({ token: { ...freshToken, rotatedAt: at(-MINUTE) } })).toEqual({
        kind: 'replay',
      });
    });

    it('replay is reported even when the replayed token has also expired', () => {
      const token = { expiresAt: at(-DAY), rotatedAt: at(-2 * DAY), revokedAt: null };
      expect(decide({ token })).toEqual({ kind: 'replay' });
    });

    it('a replay against an already-revoked session is just a rejection, with nothing more to revoke', () => {
      const token = { ...freshToken, rotatedAt: at(-MINUTE) };
      expect(decide({ token, session: { ...liveSession, revokedAt: at(-1) } })).toEqual({
        kind: 'reject',
        reason: 'revoked',
      });
    });

    it('honors a custom grace window', () => {
      const token = { ...freshToken, rotatedAt: at(-30 * SECOND) };
      expect(decide({ token, graceMs: MINUTE })).toEqual({ kind: 'concurrent_rotation' });
      expect(decide({ token, graceMs: SECOND })).toEqual({ kind: 'replay' });
    });
  });
});

describe('evaluateLegacyToken (01C section 7)', () => {
  const iat = (d: Date) => Math.floor(d.getTime() / 1000);

  it('accepts a legacy token when accepted and there is no cutoff', () => {
    expect(
      evaluateLegacyToken({ iatSeconds: iat(at(-DAY)), legacyAccepted: true, invalidBefore: null }),
    ).toEqual({
      accept: true,
    });
  });

  it('rejects everything when the global switch is off', () => {
    expect(
      evaluateLegacyToken({ iatSeconds: iat(NOW), legacyAccepted: false, invalidBefore: null }),
    ).toEqual({
      accept: false,
      reason: 'legacy_disabled',
    });
  });

  it('rejects a token issued before the customer enrolled, and accepts one issued after', () => {
    const cutoff = NOW;
    expect(
      evaluateLegacyToken({
        iatSeconds: iat(at(-DAY)),
        legacyAccepted: true,
        invalidBefore: cutoff,
      }),
    ).toEqual({
      accept: false,
      reason: 'before_cutoff',
    });
    expect(
      evaluateLegacyToken({
        iatSeconds: iat(at(MINUTE)),
        legacyAccepted: true,
        invalidBefore: cutoff,
      }),
    ).toEqual({
      accept: true,
    });
  });

  it('is conservative at the boundary: same-second tokens are treated as older', () => {
    expect(
      evaluateLegacyToken({ iatSeconds: iat(NOW), legacyAccepted: true, invalidBefore: NOW }),
    ).toEqual({
      accept: false,
      reason: 'before_cutoff',
    });
    expect(
      evaluateLegacyToken({ iatSeconds: iat(NOW), legacyAccepted: true, invalidBefore: at(500) }),
    ).toEqual({ accept: false, reason: 'before_cutoff' });
  });

  it('the global switch wins over an otherwise acceptable token', () => {
    expect(
      evaluateLegacyToken({ iatSeconds: iat(at(DAY)), legacyAccepted: false, invalidBefore: NOW }),
    ).toEqual({
      accept: false,
      reason: 'legacy_disabled',
    });
  });
});

describe('isStepUpFresh', () => {
  it('is false when there was never a step-up', () => {
    expect(isStepUpFresh(null, NOW, 300)).toBe(false);
  });

  it('is true inside the window, including the boundary, and false after', () => {
    expect(isStepUpFresh(at(-60 * SECOND), NOW, 300)).toBe(true);
    expect(isStepUpFresh(at(-300 * SECOND), NOW, 300)).toBe(true);
    expect(isStepUpFresh(at(-300 * SECOND - 1), NOW, 300)).toBe(false);
  });

  it('rejects a step-up timestamp from the future', () => {
    expect(isStepUpFresh(at(MINUTE), NOW, 300)).toBe(false);
  });

  it('rejects an invalid window', () => {
    expect(() => isStepUpFresh(NOW, NOW, 0)).toThrow();
  });
});

describe('evaluatePasswordEnrollment (01C section 6.2)', () => {
  const session = { ...liveSession, stepUpVerifiedAt: at(-60 * SECOND) };

  it('never lets a legacy token set a password, however fresh it is', () => {
    expect(evaluatePasswordEnrollment({ kind: 'legacy' }, NOW, 300)).toEqual({
      allow: false,
      reason: 'legacy_token',
    });
  });

  it('allows a live session with a fresh step-up', () => {
    expect(evaluatePasswordEnrollment({ kind: 'session', session }, NOW, 300)).toEqual({
      allow: true,
    });
  });

  it('requires a fresh step-up, not just any session', () => {
    expect(
      evaluatePasswordEnrollment(
        { kind: 'session', session: { ...session, stepUpVerifiedAt: null } },
        NOW,
        300,
      ),
    ).toEqual({ allow: false, reason: 'step_up_required' });
    expect(
      evaluatePasswordEnrollment(
        { kind: 'session', session: { ...session, stepUpVerifiedAt: at(-DAY) } },
        NOW,
        300,
      ),
    ).toEqual({ allow: false, reason: 'step_up_required' });
  });

  it('rejects a dead session before looking at step-up', () => {
    expect(
      evaluatePasswordEnrollment(
        { kind: 'session', session: { ...session, revokedAt: at(-1) } },
        NOW,
        300,
      ),
    ).toEqual({ allow: false, reason: 'session_not_live' });
  });
});
