/**
 * CUSTOMER-AUTH-01D-1: pure decision rules for the revocable customer session
 * model (CUSTOMER_AUTH_01A section 6, 01B invariants I3 to I7, 01C sections 6
 * and 7).
 *
 * No database, no clock, no I/O: every function takes the records it needs and
 * an explicit `now`, so the rules are exhaustively testable and the later
 * service layer (01D-3) cannot drift from them. Nothing imports this yet.
 *
 * Reject REASONS returned here are for logs and the audit trail only. The API
 * layer must collapse them to one generic 401 so a caller cannot tell a
 * revoked session from an expired one (01A section 6.3).
 */

/** Matches the staff concurrent-refresh window (auth/auth.service.ts). */
export const CUSTOMER_REFRESH_CONCURRENCY_GRACE_MS = 10_000;

/** PROPOSED in 01A. Callers pass their own value, so the decision stays open. */
export const CUSTOMER_SESSION_ABSOLUTE_TTL_SECONDS = 30 * 24 * 60 * 60;

export type CustomerGate = {
  status: string;
  isDeleted: boolean;
};

export type SessionTimes = {
  revokedAt: Date | null;
  absoluteExpiresAt: Date;
  idleExpiresAt: Date;
};

export type RefreshTokenTimes = {
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
};

export type SessionDeadReason = 'revoked' | 'absolute_expired' | 'idle_expired';

export type SessionLiveness = { live: true } | { live: false; reason: SessionDeadReason };

/** A customer may hold a usable session only while active and not soft-deleted (01B I7). */
export function customerMayHaveSession(customer: CustomerGate): boolean {
  return customer.status === 'active' && !customer.isDeleted;
}

/** Live exactly while not revoked and now is strictly before both expiries (01B section 5.2). */
export function sessionLiveness(session: SessionTimes, now: Date): SessionLiveness {
  if (session.revokedAt !== null) return { live: false, reason: 'revoked' };
  if (now.getTime() >= session.absoluteExpiresAt.getTime()) {
    return { live: false, reason: 'absolute_expired' };
  }
  if (now.getTime() >= session.idleExpiresAt.getTime()) {
    return { live: false, reason: 'idle_expired' };
  }
  return { live: true };
}

export function computeSessionExpiries(
  now: Date,
  limits: { absoluteSeconds: number; idleSeconds: number },
): { absoluteExpiresAt: Date; idleExpiresAt: Date } {
  assertPositiveSeconds(limits.absoluteSeconds);
  assertPositiveSeconds(limits.idleSeconds);
  const absoluteExpiresAt = new Date(now.getTime() + limits.absoluteSeconds * 1000);
  const idleCandidate = new Date(now.getTime() + limits.idleSeconds * 1000);
  return {
    absoluteExpiresAt,
    idleExpiresAt:
      idleCandidate.getTime() > absoluteExpiresAt.getTime() ? absoluteExpiresAt : idleCandidate,
  };
}

/** The idle window moves forward on refresh but never past the absolute cap. */
export function nextIdleExpiry(now: Date, idleSeconds: number, absoluteExpiresAt: Date): Date {
  assertPositiveSeconds(idleSeconds);
  const candidate = new Date(now.getTime() + idleSeconds * 1000);
  return candidate.getTime() > absoluteExpiresAt.getTime() ? absoluteExpiresAt : candidate;
}

function assertPositiveSeconds(value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error('Session limits must be positive.');
}

export type RefreshRejectReason =
  SessionDeadReason | 'customer_inactive' | 'token_revoked' | 'token_expired';

export type RefreshDecision =
  /** Usable and unused: exchange it for a successor (01B I3). */
  | { kind: 'rotate' }
  /**
   * Already rotated a moment ago, so this is almost certainly a concurrent
   * request from the same client. Reject with a retryable conflict and do NOT
   * revoke. The successor cannot be returned a second time because only its
   * hash is stored. Mirrors the staff 409 REFRESH_TOKEN_ROTATED behavior.
   */
  | { kind: 'concurrent_rotation' }
  /** Rotated earlier than the grace window: evidence of theft. Revoke the session (01B I4). */
  | { kind: 'replay' }
  | { kind: 'reject'; reason: RefreshRejectReason };

export function evaluateRefresh(input: {
  token: RefreshTokenTimes;
  session: SessionTimes;
  customer: CustomerGate;
  now: Date;
  graceMs?: number;
}): RefreshDecision {
  const { token, session, customer, now } = input;
  const graceMs = input.graceMs ?? CUSTOMER_REFRESH_CONCURRENCY_GRACE_MS;

  const liveness = sessionLiveness(session, now);
  if (!liveness.live) return { kind: 'reject', reason: liveness.reason };
  if (!customerMayHaveSession(customer)) return { kind: 'reject', reason: 'customer_inactive' };
  if (token.revokedAt !== null) return { kind: 'reject', reason: 'token_revoked' };

  // Checked before expiry: an old credential presented after its successor
  // exists is replay evidence whether or not it has also expired.
  if (token.rotatedAt !== null) {
    const sinceRotation = now.getTime() - token.rotatedAt.getTime();
    return sinceRotation <= graceMs ? { kind: 'concurrent_rotation' } : { kind: 'replay' };
  }

  if (now.getTime() >= token.expiresAt.getTime())
    return { kind: 'reject', reason: 'token_expired' };
  return { kind: 'rotate' };
}

export type LegacyTokenDecision =
  { accept: true } | { accept: false; reason: 'legacy_disabled' | 'before_cutoff' };

/**
 * Whether an otherwise-valid legacy 90-day token may still be used (01C
 * section 7). `invalidBefore` is the proposed `legacy_tokens_invalid_before`
 * (01B-AMEND-1, NOT yet approved). Null means "no cutoff".
 *
 * Comparison is conservative: a token whose second-precision `iat` is at or
 * before the cutoff is rejected, so a token issued in the same second as an
 * enrollment is treated as older. Safe-side, at worst one forced re-login.
 */
export function evaluateLegacyToken(input: {
  iatSeconds: number;
  legacyAccepted: boolean;
  invalidBefore: Date | null;
}): LegacyTokenDecision {
  if (!input.legacyAccepted) return { accept: false, reason: 'legacy_disabled' };
  if (input.invalidBefore !== null && input.iatSeconds * 1000 <= input.invalidBefore.getTime()) {
    return { accept: false, reason: 'before_cutoff' };
  }
  return { accept: true };
}

/** True only if a re-verification happened within `windowSeconds` before now. */
export function isStepUpFresh(
  stepUpVerifiedAt: Date | null,
  now: Date,
  windowSeconds: number,
): boolean {
  assertPositiveSeconds(windowSeconds);
  if (stepUpVerifiedAt === null) return false;
  const age = now.getTime() - stepUpVerifiedAt.getTime();
  return age >= 0 && age <= windowSeconds * 1000;
}

export type PasswordEnrollmentDecision =
  | { allow: true }
  | { allow: false; reason: 'legacy_token' | 'session_not_live' | 'step_up_required' };

/**
 * 01C section 6.2: a legacy token alone can never set a password, so a stolen
 * token cannot pin a credential on the account. A new-model session may only
 * if it is live and its step-up proof (a fresh OTP) is recent.
 */
export function evaluatePasswordEnrollment(
  caller:
    | { kind: 'legacy' }
    | { kind: 'session'; session: SessionTimes & { stepUpVerifiedAt: Date | null } },
  now: Date,
  stepUpWindowSeconds: number,
): PasswordEnrollmentDecision {
  if (caller.kind === 'legacy') return { allow: false, reason: 'legacy_token' };
  if (!sessionLiveness(caller.session, now).live)
    return { allow: false, reason: 'session_not_live' };
  if (!isStepUpFresh(caller.session.stepUpVerifiedAt, now, stepUpWindowSeconds)) {
    return { allow: false, reason: 'step_up_required' };
  }
  return { allow: true };
}
