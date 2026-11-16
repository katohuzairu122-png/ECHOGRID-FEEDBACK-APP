import { describe, it, expect } from 'vitest';
import {
  classifyRecoveryRisk,
  isLegalRecoveryTransition,
  isTerminalRecoveryStatus,
  recoveryPathFor,
  RECOVERY_HOLD_SECONDS,
  RECOVERY_RECENT_PHONE_WINDOW_SECONDS,
  RECOVERY_TRANSITIONS,
  type RecoveryFactor,
} from './customer-recovery-policy';
import { CUSTOMER_RECOVERY_ATTEMPT_STATUSES } from '../db/schema';
import {
  assertRecoverySecret,
  RecoveryConfigError,
  resolveCustomerRecoverySecret,
} from './customer-recovery-config';
import { createCustomerRecoveryService } from './customer-recovery-attempt.service';
import type { Database } from '../db/client';

const set = (...f: RecoveryFactor[]) => new Set<RecoveryFactor>(f);
const DAY = 86_400_000;

describe('recovery paths (D1, D3)', () => {
  it('needs two DISTINCT factors; no single factor ever satisfies the policy', () => {
    for (const one of ['email', 'phone', 'code'] as const) expect(recoveryPathFor(set(one))).toBeNull();
    expect(recoveryPathFor(set())).toBeNull();
  });
  it('maps the approved pairs', () => {
    expect(recoveryPathFor(set('email', 'phone'))).toBe('email_phone');
    expect(recoveryPathFor(set('phone', 'code'))).toBe('phone_code');
    expect(recoveryPathFor(set('email', 'code'))).toBe('email_code');
    expect(recoveryPathFor(set('email', 'phone', 'code'))).toBe('email_phone');
  });
});

describe('risk classification (D2, D5)', () => {
  const now = Date.UTC(2026, 10, 16);
  it('any recovery-code path is high risk', () => {
    expect(classifyRecoveryRisk({ path: 'phone_code', nowMs: now, phoneVerifiedAtMs: now - 100 * DAY }).risk).toBe('high');
    expect(classifyRecoveryRisk({ path: 'email_code', nowMs: now, phoneVerifiedAtMs: null }).reason).toBe('recovery_code_path');
  });
  it('email + phone is standard only when the phone was verified long ago', () => {
    expect(classifyRecoveryRisk({ path: 'email_phone', nowMs: now, phoneVerifiedAtMs: now - 30 * DAY })).toEqual({ risk: 'standard', reason: 'both_factors' });
  });
  it('a recently verified phone, or one with no verification time, escalates to high risk', () => {
    expect(classifyRecoveryRisk({ path: 'email_phone', nowMs: now, phoneVerifiedAtMs: now - DAY })).toEqual({ risk: 'high', reason: 'recent_phone_verification' });
    expect(classifyRecoveryRisk({ path: 'email_phone', nowMs: now, phoneVerifiedAtMs: null }).risk).toBe('high');
    const exactlyAtWindow = now - RECOVERY_RECENT_PHONE_WINDOW_SECONDS * 1000;
    expect(classifyRecoveryRisk({ path: 'email_phone', nowMs: now, phoneVerifiedAtMs: exactlyAtWindow }).risk).toBe('standard');
  });
  it('the hold is the approved 24 hours', () => expect(RECOVERY_HOLD_SECONDS).toBe(86_400));
});

describe('state machine transitions', () => {
  it('covers exactly the persisted statuses', () => {
    expect(Object.keys(RECOVERY_TRANSITIONS).sort()).toEqual([...CUSTOMER_RECOVERY_ATTEMPT_STATUSES].sort());
  });
  it('terminal states have no exit', () => {
    for (const s of ['cancelled', 'expired', 'completed', 'rejected'] as const) {
      expect(isTerminalRecoveryStatus(s)).toBe(true);
      for (const to of CUSTOMER_RECOVERY_ATTEMPT_STATUSES) expect(isLegalRecoveryTransition(s, to)).toBe(false);
    }
  });
  it('only a verified attempt can complete, and a hold never skips back', () => {
    expect(isLegalRecoveryTransition('awaiting_factors', 'completed')).toBe(false);
    expect(isLegalRecoveryTransition('factors_verified', 'completed')).toBe(true);
    expect(isLegalRecoveryTransition('security_hold', 'completed')).toBe(true);
    expect(isLegalRecoveryTransition('security_hold', 'awaiting_factors')).toBe(false);
    expect(isLegalRecoveryTransition('security_hold', 'factors_verified')).toBe(false);
    expect(isLegalRecoveryTransition('awaiting_factors', 'security_hold')).toBe(true);
  });
});

describe('dedicated recovery secret (fail closed)', () => {
  const good = 'recovery-secret-with-at-least-thirty-two-bytes!!';
  it('resolves a proper dedicated secret', () => {
    expect(resolveCustomerRecoverySecret({ CUSTOMER_RECOVERY_HMAC_SECRET: good, CUSTOMER_JWT_SECRET: 'another-secret-value-that-is-different-0000' })).toBe(good);
  });
  it.each([undefined, null, '', 42, 'too-short'])('refuses %s', (value) => {
    expect(() => resolveCustomerRecoverySecret({ CUSTOMER_RECOVERY_HMAC_SECRET: value })).toThrow(RecoveryConfigError);
    expect(() => assertRecoverySecret(value)).toThrow(RecoveryConfigError);
  });
  it('refuses a value reused from another secret binding', () => {
    expect(() => resolveCustomerRecoverySecret({ CUSTOMER_RECOVERY_HMAC_SECRET: good, CUSTOMER_JWT_SECRET: good })).toThrowError(/reused/);
  });
  it('does not put the secret in the error', () => {
    try { resolveCustomerRecoverySecret({ CUSTOMER_RECOVERY_HMAC_SECRET: 'short' }); } catch (e) { expect(String(e)).not.toContain('short-secret'); expect(String(e)).not.toContain("'short'"); }
  });
  it('the service cannot be constructed without a secret or with a hold shorter than 24 hours', () => {
    const base = { db: {} as Database, hasher: { hash: async () => '', verify: async () => false }, passwordPolicy: { minLength: 10 }, phoneProofMaxAgeSeconds: 300 };
    expect(() => createCustomerRecoveryService({ ...base, hmacSecret: '' })).toThrow(RecoveryConfigError);
    expect(() => createCustomerRecoveryService({ ...base, hmacSecret: 'short' })).toThrow(RecoveryConfigError);
    expect(() => createCustomerRecoveryService({ ...base, hmacSecret: good, holdSeconds: 3600 })).toThrow(/24 hours/);
    expect(() => createCustomerRecoveryService({ ...base, hmacSecret: good })).not.toThrow();
  });
});
