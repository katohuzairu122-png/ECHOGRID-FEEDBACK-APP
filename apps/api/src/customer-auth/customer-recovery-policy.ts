import type {
  CustomerRecoveryAttemptStatus,
  CustomerRecoveryRisk,
  CustomerRecoveryRiskReason,
} from '../db/schema/customer-recovery-attempts';

/**
 * CUSTOMER-AUTH-S4-02: pure recovery policy. Database-free so the owner rulings
 * can be read, and tested, in one place.
 *
 *  D1 two independent factors. A recovery code is a factor, never sufficient alone.
 *  D2 24-hour security hold for HIGH-risk recovery.
 *  D3 lost email = phone + code; lost phone = email + code; both available = email + phone;
 *     both lost = no self-service (one factor can never satisfy the policy).
 *  D4 password reset only (this module has no email or phone change).
 *  D5/D6 an unverified phone is never a factor; phone-based recovery remains high risk unless an
 *  approved recency threshold is supplied. The repository has no authoritative recycled-number signal.
 *
 * The owner has approved elevated assurance but has not specified what counts as "recent" or
 * supplied an authoritative recycled-number signal. Therefore production composition supplies no
 * recency threshold and all phone-dependent recovery takes the existing high-risk hold path.
 */
export const RECOVERY_HOLD_SECONDS = 24 * 60 * 60;
/** Time to supply the second factor, from initiation. */
export const RECOVERY_FACTORS_WINDOW_SECONDS = 60 * 60;
/** Standard-risk completion window, from the moment the second factor is verified. */
export const RECOVERY_STANDARD_COMPLETION_SECONDS = 15 * 60;
/** High-risk completion window, from the end of the hold. */
export const RECOVERY_POST_HOLD_COMPLETION_SECONDS = 24 * 60 * 60;
/** Cancel-token lifetime from initiation (extended when a hold starts). */
export const RECOVERY_CANCEL_WINDOW_SECONDS = 72 * 60 * 60;

export type RecoveryFactor = 'email' | 'phone' | 'code';
export type RecoveryPath = 'email_phone' | 'phone_code' | 'email_code';

/** The only legal transitions. Anything else is refused by the service. */
export const RECOVERY_TRANSITIONS: Readonly<Record<CustomerRecoveryAttemptStatus, readonly CustomerRecoveryAttemptStatus[]>> = {
  awaiting_factors: ['factors_verified', 'security_hold', 'cancelled', 'expired', 'rejected'],
  factors_verified: ['completed', 'cancelled', 'expired', 'rejected'],
  security_hold: ['completed', 'cancelled', 'expired', 'rejected'],
  cancelled: [],
  expired: [],
  completed: [],
  rejected: [],
};

export function isLegalRecoveryTransition(
  from: CustomerRecoveryAttemptStatus,
  to: CustomerRecoveryAttemptStatus,
): boolean {
  return RECOVERY_TRANSITIONS[from].includes(to);
}

export function isTerminalRecoveryStatus(status: CustomerRecoveryAttemptStatus): boolean {
  return RECOVERY_TRANSITIONS[status].length === 0;
}

/** Which D3 path the verified factors satisfy, or null. One factor never satisfies anything. */
export function recoveryPathFor(factors: ReadonlySet<RecoveryFactor>): RecoveryPath | null {
  if (factors.has('email') && factors.has('phone')) return 'email_phone';
  if (factors.has('phone') && factors.has('code')) return 'phone_code';
  if (factors.has('email') && factors.has('code')) return 'email_code';
  return null;
}

export type RecoveryRiskInput = {
  path: RecoveryPath;
  /** Database time, never a client or application clock. */
  nowMs: number;
  phoneVerifiedAtMs: number | null;
  recentPhoneWindowSeconds?: number;
};

export function classifyRecoveryRisk(input: RecoveryRiskInput): {
  risk: CustomerRecoveryRisk;
  reason: CustomerRecoveryRiskReason;
} {
  if (input.path !== 'email_phone') return { risk: 'high', reason: 'recovery_code_path' };
  const windowSeconds = input.recentPhoneWindowSeconds;
  // No threshold is inferred from the former provisional seven-day value. Until one is approved,
  // unknown age, future timestamps, and every phone-based recovery are treated as high risk.
  if (
    windowSeconds === undefined ||
    !Number.isFinite(windowSeconds) ||
    windowSeconds <= 0 ||
    input.phoneVerifiedAtMs === null ||
    !Number.isFinite(input.phoneVerifiedAtMs) ||
    input.phoneVerifiedAtMs > input.nowMs ||
    input.nowMs - input.phoneVerifiedAtMs < windowSeconds * 1000
  ) {
    return { risk: 'high', reason: 'recent_phone_verification' };
  }
  return { risk: 'standard', reason: 'both_factors' };
}
