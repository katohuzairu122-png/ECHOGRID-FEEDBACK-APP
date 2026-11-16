import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/client';
import {
  CUSTOMER_RECOVERY_MAX_FACTOR_FAILURES,
  customerAuthChallenges,
  customerCredentials,
  customerRecoveryAttempts,
  customerRecoveryCodeSets,
  customers,
  type CustomerRecoveryAttemptStatus,
} from '../db/schema';
import { PASSWORD_ITERATIONS } from '../auth/password';
import type { Pbkdf2Worker } from '../auth/pbkdf2-worker';
import { CustomerAuthChallengeRepository } from '../repositories/customer-auth-challenge.repository';
import { CustomerAuthEventRepository } from '../repositories/customer-auth-event.repository';
import { CustomerCredentialRepository } from '../repositories/customer-credential.repository';
import { CustomerSessionRepository } from '../repositories/customer-session.repository';
import { customerChallengeDigest, normalizeLoginEmail } from './customer-email-challenge-digest';
import type { RegistrationProofDelivery } from './customer-email-auth.service';
import { assertRecoverySecret } from './customer-recovery-config';
import {
  classifyRecoveryRisk,
  recoveryPathFor,
  RECOVERY_CANCEL_WINDOW_SECONDS,
  RECOVERY_FACTORS_WINDOW_SECONDS,
  RECOVERY_HOLD_SECONDS,
  RECOVERY_POST_HOLD_COMPLETION_SECONDS,
  RECOVERY_STANDARD_COMPLETION_SECONDS,
  type RecoveryFactor,
} from './customer-recovery-policy';
import { createRecoveryCodeRedeemer } from './customer-recovery-code.service';
import { checkPasswordPolicy, isHashableLength, normalizePassword, type PasswordPolicyConfig } from './customer-password-policy';
import { customerMayHaveSession } from './session-policy';
import { isUuid } from './session-tokens';

/**
 * CUSTOMER-AUTH-S4-02: two-factor recovery orchestration for email-linked customers
 * (password reset only, D4). INTERNAL ONLY: no route, UI or session is wired to
 * this, and it issues NO session on success.
 *
 * Security properties, each enforced by the database where possible:
 *  - the attempt row is the durable state machine (customer-recovery-attempts.ts);
 *  - every security timestamp (hold deadline, expiry, ended_at) comes from the
 *    DATABASE clock, so a client or worker clock cannot shorten a hold;
 *  - a recovery needs two DISTINCT factors; a recovery code or a phone alone never completes;
 *  - nothing proceeds until the notifier ACCEPTED the initiation notice, and a
 *    high-risk attempt cannot complete until the hold notice was accepted too;
 *  - the hold is an additional safeguard and never a substitute for a factor;
 *  - the new password, the session revocation, the legacy cutoff, the recovery-code
 *    set revocation, the attempt completion and the audit row commit together or not at all.
 *
 * Failure policy: every public method returns ONE generic `{ ok: false }`; the real
 * reason goes to the audit trail. A missing limiter, notifier or delivery adapter
 * fails CLOSED. Accepted by the notifier is NOT delivered; operators must monitor
 * delivery out of band.
 */

/** Same shape as the approved customer-email limiter. Only budgets from its closed set are requested. */
export type RecoveryLimiter = (input: { key: string; limit: number; windowSeconds: number }) => Promise<boolean>;

export type RecoveryNoticeKind = 'initiated' | 'hold_started' | 'cancelled' | 'completed';
export type RecoveryNoticeResult = { email: 'accepted' | 'failed'; phone?: 'accepted' | 'failed' | 'skipped' };
/**
 * Contract for the delivery adapter (to be wired by a later block): it MUST NOT log the notice,
 * and `accepted` means handed to the provider, not delivered. The message must never contain a
 * recovery code, OTP or password; `cancelToken` is only for building the cancellation link.
 */
export type RecoveryNotifier = (notice: {
  kind: RecoveryNoticeKind;
  attemptId: string;
  recipients: { email: string; phone: string | null };
  cancelToken?: string;
  holdUntil?: Date;
}) => Promise<RecoveryNoticeResult>;

/** A phone proof that was minted FOR recovery. A generic sign-in proof is not accepted. */
export type RecoveryPhoneProof = {
  readonly phone: string;
  readonly verifiedAt: Date;
  readonly source: 'twilio_verify' | 'local_otp';
  readonly purpose: 'account_recovery';
};

/**
 * The one-time-code provider. The provider keys a code by PHONE ALONE, so purpose binding is enforced here instead: a
 * code can only be checked for an attempt that requested it through `requestPhoneOtp`, and an approved check is turned
 * into a recovery-purpose proof on the server, never accepted from a client.
 */
export type RecoveryPhoneOtp = {
  send(phone: string): Promise<void>;
  check(phone: string, code: string): Promise<boolean>;
};

export type RecoveryOutcome = { ok: false } | { ok: true; status: CustomerRecoveryAttemptStatus; holdUntil?: Date };
const FAIL = { ok: false } as const;

type Surface = 'initiate' | 'email_challenge' | 'email_verify' | 'phone_otp' | 'phone_factor' | 'code_verify' | 'cancel' | 'complete';
type Dimension = 'source' | 'customer' | 'attempt_source';
/** Only budgets from the approved closed set {5/900, 3/3600, 10/3600} of the customer-email limiter. */
const BUDGETS: Record<Surface, ReadonlyArray<readonly [Dimension, number, number]>> = {
  initiate: [['source', 10, 3600], ['customer', 3, 3600]],
  email_challenge: [['source', 10, 3600], ['customer', 3, 3600]],
  email_verify: [['source', 5, 900], ['customer', 5, 900]],
  // Every send costs real SMS money, so it is budgeted like email delivery.
  phone_otp: [['source', 10, 3600], ['customer', 3, 3600]],
  phone_factor: [['source', 5, 900], ['customer', 5, 900]],
  code_verify: [['source', 5, 900], ['customer', 5, 900]],
  // Cancellation is the customer's safety net during a hold, so its budget is per attempt AND source: someone who
  // merely knows an attempt id cannot exhaust a budget that the real owner, on another source, needs.
  cancel: [['source', 10, 3600], ['attempt_source', 5, 900]],
  complete: [['source', 5, 900], ['customer', 5, 900]],
};

const NON_TERMINAL = ['awaiting_factors', 'factors_verified', 'security_hold'] as const;
const PHONE_FORMAT = /^\+[1-9][0-9]{6,14}$/;
const EMAIL_CHALLENGE_PURPOSE = 'email_recovery' as const;
const MAX_LIVE_EMAIL_CHALLENGES = 3;
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

class Rejected extends Error {}

export function createCustomerRecoveryService(config: {
  db: Database;
  /** The DEDICATED recovery secret (resolveCustomerRecoverySecret). */
  hmacSecret: string;
  hasher: Pbkdf2Worker;
  passwordPolicy: PasswordPolicyConfig;
  passwordIterations?: number;
  limiter?: RecoveryLimiter;
  notifier?: RecoveryNotifier;
  deliverEmailChallenge?: RegistrationProofDelivery;
  phoneOtp?: RecoveryPhoneOtp;
  phoneProofMaxAgeSeconds: number;
  recentPhoneWindowSeconds?: number;
  /** Must not be shorter than the approved 24 hours. */
  holdSeconds?: number;
  /** Application clock: audit timestamps and phone-proof freshness ONLY. Never used for the hold or expiry. */
  now?: () => Date;
}) {
  assertRecoverySecret(config.hmacSecret);
  const holdSeconds = config.holdSeconds ?? RECOVERY_HOLD_SECONDS;
  if (holdSeconds < RECOVERY_HOLD_SECONDS) throw new Error('Recovery hold may not be shorter than 24 hours');
  const clock = config.now ?? (() => new Date());
  const iterations = config.passwordIterations ?? PASSWORD_ITERATIONS;
  const redeemCode = createRecoveryCodeRedeemer({ hmacSecret: config.hmacSecret });
  const encoder = new TextEncoder();

  async function mac(label: string, ...parts: string[]): Promise<string> {
    const key = await crypto.subtle.importKey('raw', encoder.encode(config.hmacSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`echo-grid/customer-recovery/v1/${label}\0${parts.join('\0')}`))));
  }
  const newCancelToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
  const cancelDigest = (attemptId: string, token: string) => mac('cancel', attemptId, token);

  /** Fail-closed rate limiting with privacy-preserving keys. A missing limiter or source is a denial. */
  async function allowed(surface: Surface, who: { sourceKey?: string | undefined; customerId?: string | undefined; attemptId?: string | undefined }): Promise<boolean> {
    if (!config.limiter || !who.sourceKey || who.sourceKey.length < 8) return false;
    try {
      const results = await Promise.all(BUDGETS[surface].map(async ([dimension, limit, windowSeconds]) => {
        const value = dimension === 'source' ? who.sourceKey
          : dimension === 'customer' ? who.customerId
          : who.attemptId ? `${who.attemptId}|${who.sourceKey}` : undefined;
        if (!value) return dimension !== 'source'; // an unknown customer or attempt cannot be keyed; the source budget still applies
        return config.limiter!({ key: `customer-recovery:${surface}:${dimension}:${await mac('rl', surface, dimension, value)}`, limit, windowSeconds });
      }));
      return results.every(Boolean);
    } catch {
      return false;
    }
  }

  const events = (tx: Transaction) => new CustomerAuthEventRepository(tx);
  const dbNow = async (tx: Transaction): Promise<Date> => {
    const result = await tx.execute(sql`select now() as now`);
    return new Date((result.rows[0] as { now: string | Date }).now);
  };
  const interval = (seconds: number) => sql`make_interval(secs => ${seconds})`;

  async function customerIdOf(attemptId: string): Promise<string | undefined> {
    if (!isUuid(attemptId)) return undefined;
    const [row] = await config.db.select({ customerId: customerRecoveryAttempts.customerId })
      .from(customerRecoveryAttempts).where(eq(customerRecoveryAttempts.id, attemptId));
    return row?.customerId;
  }

  /** Expires a stale attempt (database clock), then returns it locked, or null if absent or terminal. */
  async function lockLive(tx: Transaction, attemptId: string) {
    await tx.update(customerRecoveryAttempts)
      .set({ status: 'expired', endedAt: sql`now()`, endedReason: 'expired' })
      .where(and(eq(customerRecoveryAttempts.id, attemptId), inArray(customerRecoveryAttempts.status, [...NON_TERMINAL]), sql`${customerRecoveryAttempts.expiresAt} <= now()`));
    const [row] = await tx.select().from(customerRecoveryAttempts)
      .where(eq(customerRecoveryAttempts.id, attemptId)).for('update');
    return row && (NON_TERMINAL as readonly string[]).includes(row.status) ? row : null;
  }

  async function recipientsOf(tx: Transaction, customerId: string) {
    const [row] = await tx.select({
      email: customerCredentials.loginEmail, verifiedAt: customerCredentials.loginEmailVerifiedAt,
      phone: customers.phone, phoneVerifiedAt: customers.phoneVerifiedAt, status: customers.status, isDeleted: customers.isDeleted,
    }).from(customerCredentials).innerJoin(customers, eq(customers.id, customerCredentials.customerId))
      .where(eq(customerCredentials.customerId, customerId));
    if (!row?.email || !row.verifiedAt || !customerMayHaveSession({ status: row.status, isDeleted: row.isDeleted })) return null;
    return { email: row.email, phone: row.phone && row.phoneVerifiedAt ? row.phone : null, phoneVerifiedAt: row.phoneVerifiedAt, phoneNumber: row.phone };
  }

  async function reject(tx: Transaction, attemptId: string, customerId: string, reason: 'notification_failed' | 'factor_budget_exhausted', now: Date) {
    await tx.update(customerRecoveryAttempts)
      .set({ status: 'rejected', endedAt: sql`now()`, endedReason: reason })
      .where(and(eq(customerRecoveryAttempts.id, attemptId), inArray(customerRecoveryAttempts.status, [...NON_TERMINAL])));
    await events(tx).append({
      customerId, eventType: 'recovery_failed', outcome: reason === 'factor_budget_exhausted' ? 'blocked' : 'failure',
      reasonCode: reason === 'notification_failed' ? 'notice_not_accepted' : 'factor_budget_exhausted', now,
    });
  }

  /** A failed factor attempt spends the attempt's budget; the writes commit because the caller returns normally. */
  async function spendFailure(tx: Transaction, attempt: { id: string; customerId: string; factorFailures: number }, reasonCode: string, now: Date) {
    const failures = attempt.factorFailures + 1;
    await tx.update(customerRecoveryAttempts).set({ factorFailures: failures }).where(eq(customerRecoveryAttempts.id, attempt.id));
    if (failures >= CUSTOMER_RECOVERY_MAX_FACTOR_FAILURES) {
      await reject(tx, attempt.id, attempt.customerId, 'factor_budget_exhausted', now);
      return;
    }
    await events(tx).append({ customerId: attempt.customerId, eventType: 'recovery_failed', outcome: 'failure', reasonCode, metadata: { attempt: failures }, now });
  }

  /**
   * After a factor was recorded: when a legal two-factor path exists, classify the risk and move to
   * factors_verified (standard) or security_hold (high) using DATABASE time. Returns a hold when one started.
   */
  async function advance(tx: Transaction, attemptId: string, customerId: string, factor: RecoveryFactor, holdToken: string, holdDigest: string, now: Date) {
    const [row] = await tx.select().from(customerRecoveryAttempts).where(eq(customerRecoveryAttempts.id, attemptId));
    if (!row) throw new Rejected();
    const present = new Set<RecoveryFactor>();
    if (row.emailFactorAt) present.add('email');
    if (row.phoneFactorAt) present.add('phone');
    if (row.codeFactorAt) present.add('code');
    await events(tx).append({ customerId, eventType: 'recovery_factor_verified', outcome: 'success', reasonCode: `${factor}_factor`, now });
    const path = recoveryPathFor(present);
    if (!path) return { status: 'awaiting_factors' as const };
    const [customer] = await tx.select({ phoneVerifiedAt: customers.phoneVerifiedAt }).from(customers).where(eq(customers.id, customerId));
    const databaseNow = await dbNow(tx);
    const { risk, reason } = classifyRecoveryRisk({
      path, nowMs: databaseNow.getTime(), phoneVerifiedAtMs: customer?.phoneVerifiedAt?.getTime() ?? null,
      ...(config.recentPhoneWindowSeconds !== undefined ? { recentPhoneWindowSeconds: config.recentPhoneWindowSeconds } : {}),
    });
    if (risk === 'standard') {
      await tx.update(customerRecoveryAttempts).set({
        status: 'factors_verified', risk, riskReason: reason, expiresAt: sql`now() + ${interval(RECOVERY_STANDARD_COMPLETION_SECONDS)}`,
      }).where(eq(customerRecoveryAttempts.id, attemptId));
      return { status: 'factors_verified' as const };
    }
    const [held] = await tx.update(customerRecoveryAttempts).set({
      status: 'security_hold', risk, riskReason: reason,
      holdStartedAt: sql`now()`, holdUntil: sql`now() + ${interval(holdSeconds)}`,
      expiresAt: sql`now() + ${interval(holdSeconds + RECOVERY_POST_HOLD_COMPLETION_SECONDS)}`,
      // A fresh cancel token for the hold notice (the initiation token is replaced, so exactly one is live).
      cancelDigest: holdDigest, cancelExpiresAt: sql`now() + ${interval(holdSeconds + RECOVERY_POST_HOLD_COMPLETION_SECONDS)}`,
    }).where(eq(customerRecoveryAttempts.id, attemptId)).returning({ holdUntil: customerRecoveryAttempts.holdUntil });
    await events(tx).append({ customerId, eventType: 'recovery_hold_started', outcome: 'success', reasonCode: reason, now });
    void holdToken;
    return { status: 'security_hold' as const, holdUntil: held?.holdUntil ?? undefined };
  }

  /** Post-commit: tell the customer a hold started. The hold can complete only after the notice was ACCEPTED. */
  async function announceHold(attemptId: string, customerId: string, holdUntil: Date | undefined, holdToken: string): Promise<boolean> {
    const recipients = await config.db.transaction((tx) => recipientsOf(tx, customerId));
    let accepted = false;
    if (recipients && config.notifier) {
      try {
        const result = await config.notifier({
          kind: 'hold_started', attemptId, recipients: { email: recipients.email, phone: recipients.phone },
          cancelToken: holdToken, ...(holdUntil ? { holdUntil } : {}),
        });
        accepted = result.email === 'accepted';
      } catch { accepted = false; }
    }
    await config.db.transaction(async (tx) => {
      const now = clock();
      if (accepted) {
        await tx.update(customerRecoveryAttempts).set({ holdNoticeAcceptedAt: sql`now()` })
          .where(and(eq(customerRecoveryAttempts.id, attemptId), eq(customerRecoveryAttempts.status, 'security_hold'), isNull(customerRecoveryAttempts.holdNoticeAcceptedAt)));
      } else {
        await reject(tx, attemptId, customerId, 'notification_failed', now);
      }
    });
    return accepted;
  }

  /** Shared body of the three factor verifications. */
  async function verifyFactor(
    attemptId: string,
    sourceKey: string | undefined,
    surface: Surface,
    factor: RecoveryFactor,
    check: (tx: Transaction, attempt: NonNullable<Awaited<ReturnType<typeof lockLive>>>, now: Date) => Promise<boolean | 'budget'>,
    enforceLimit = true,
  ): Promise<RecoveryOutcome> {
    const customerId = await customerIdOf(attemptId);
    if (enforceLimit && !(await allowed(surface, { sourceKey, customerId, attemptId }))) return FAIL;
    const holdToken = newCancelToken();
    const holdDigest = await cancelDigest(attemptId, holdToken);
    const outcome = await config.db.transaction(async (tx) => {
      const attempt = await lockLive(tx, attemptId);
      const slot = factor === 'email' ? attempt?.emailFactorAt : factor === 'phone' ? attempt?.phoneFactorAt : attempt?.codeFactorAt;
      if (!attempt || attempt.status !== 'awaiting_factors' || !attempt.noticeAcceptedAt || slot) return FAIL;
      const now = clock();
      const verified = await check(tx, attempt, now);
      if (verified !== true) {
        if (verified === false) await spendFailure(tx, attempt, `${factor}_factor_invalid`, now);
        return FAIL;
      }
      const column = factor === 'email' ? { emailFactorAt: sql`now()` } : factor === 'code' ? { codeFactorAt: sql`now()` } : null;
      if (column) await tx.update(customerRecoveryAttempts).set(column).where(eq(customerRecoveryAttempts.id, attemptId));
      const next = await advance(tx, attemptId, attempt.customerId, factor, holdToken, holdDigest, now);
      return { ok: true, status: next.status, ...(next.status === 'security_hold' && next.holdUntil ? { holdUntil: next.holdUntil } : {}), customerId: attempt.customerId } as const;
    });
    if (!outcome.ok) return FAIL;
    if (outcome.status === 'security_hold') {
      const announced = await announceHold(attemptId, outcome.customerId, outcome.holdUntil, holdToken);
      return announced ? { ok: true, status: 'security_hold', ...(outcome.holdUntil ? { holdUntil: outcome.holdUntil } : {}) } : FAIL;
    }
    return { ok: true, status: outcome.status };
  }

  /** Records a recovery-purpose phone proof as the attempt's phone factor. */
  async function recordPhoneProof(attemptId: string, sourceKey: string | undefined, proof: RecoveryPhoneProof, enforceLimit: boolean): Promise<RecoveryOutcome> {
    if (!proof || proof.purpose !== 'account_recovery' || typeof proof.phone !== 'string' || !PHONE_FORMAT.test(proof.phone) ||
        !(proof.verifiedAt instanceof Date)) return FAIL;
    const age = clock().getTime() - proof.verifiedAt.getTime();
    if (!(age >= 0 && age <= config.phoneProofMaxAgeSeconds * 1000)) return FAIL;
    return verifyFactor(attemptId, sourceKey, 'phone_factor', 'phone', async (tx, attempt) => {
      const [customer] = await tx.select({ phone: customers.phone, phoneVerifiedAt: customers.phoneVerifiedAt }).from(customers).where(eq(customers.id, attempt.customerId));
      // D6: only the customer's own VERIFIED phone can ever be a factor.
      if (!customer?.phone || !customer.phoneVerifiedAt || customer.phone !== proof.phone) return false;
      // A proof obtained before this attempt began cannot be replayed into it.
      if (proof.verifiedAt.getTime() < attempt.createdAt.getTime()) return false;
      const [reused] = await tx.select({ id: customerRecoveryAttempts.id }).from(customerRecoveryAttempts)
        .where(and(eq(customerRecoveryAttempts.customerId, attempt.customerId), eq(customerRecoveryAttempts.phoneProofVerifiedAt, proof.verifiedAt)));
      if (reused) return false;
      await tx.update(customerRecoveryAttempts).set({ phoneFactorAt: sql`now()`, phoneProofVerifiedAt: proof.verifiedAt })
        .where(eq(customerRecoveryAttempts.id, attempt.id));
      return true;
    }, enforceLimit);
  }

  return {
    /** Starts an attempt. The customer is notified BEFORE any factor is accepted. */
    async initiate(input: { customerId: string; sourceKey?: string }): Promise<{ ok: false } | { ok: true; attemptId: string }> {
      if (!isUuid(input.customerId) || !config.notifier) return FAIL;
      if (!(await allowed('initiate', { sourceKey: input.sourceKey, customerId: input.customerId }))) return FAIL;
      const token = newCancelToken();
      const made = await config.db.transaction(async (tx) => {
        const now = clock();
        const [customer] = await tx.select().from(customers).where(eq(customers.id, input.customerId)).for('update');
        const recipients = customer ? await recipientsOf(tx, input.customerId) : null;
        if (!customer || !recipients) return null;
        await tx.update(customerRecoveryAttempts)
          .set({ status: 'expired', endedAt: sql`now()`, endedReason: 'expired' })
          .where(and(eq(customerRecoveryAttempts.customerId, input.customerId), inArray(customerRecoveryAttempts.status, [...NON_TERMINAL]), sql`${customerRecoveryAttempts.expiresAt} <= now()`));
        // An attempt that never verified anything cannot hold the slot against the real owner.
        await tx.update(customerRecoveryAttempts)
          .set({ status: 'rejected', endedAt: sql`now()`, endedReason: 'superseded' })
          .where(and(eq(customerRecoveryAttempts.customerId, input.customerId), eq(customerRecoveryAttempts.status, 'awaiting_factors'),
            isNull(customerRecoveryAttempts.emailFactorAt), isNull(customerRecoveryAttempts.phoneFactorAt), isNull(customerRecoveryAttempts.codeFactorAt)));
        const [open] = await tx.select({ id: customerRecoveryAttempts.id }).from(customerRecoveryAttempts)
          .where(and(eq(customerRecoveryAttempts.customerId, input.customerId), inArray(customerRecoveryAttempts.status, [...NON_TERMINAL])));
        if (open) return null;
        const id = crypto.randomUUID();
        await tx.insert(customerRecoveryAttempts).values({
          id, customerId: input.customerId, cancelDigest: await cancelDigest(id, token),
          expiresAt: sql`now() + ${interval(RECOVERY_FACTORS_WINDOW_SECONDS)}`,
          cancelExpiresAt: sql`now() + ${interval(RECOVERY_CANCEL_WINDOW_SECONDS)}`,
        });
        await events(tx).append({ customerId: input.customerId, eventType: 'recovery_started', outcome: 'success', reasonCode: 'attempt_created', now });
        return { id, recipients };
      });
      if (!made) return FAIL;
      let accepted = false;
      try {
        const result = await config.notifier({ kind: 'initiated', attemptId: made.id, recipients: { email: made.recipients.email, phone: made.recipients.phone }, cancelToken: token });
        accepted = result.email === 'accepted';
      } catch { accepted = false; }
      await config.db.transaction(async (tx) => {
        if (accepted) {
          await tx.update(customerRecoveryAttempts).set({ noticeAcceptedAt: sql`now()` })
            .where(and(eq(customerRecoveryAttempts.id, made.id), eq(customerRecoveryAttempts.status, 'awaiting_factors'), isNull(customerRecoveryAttempts.noticeAcceptedAt)));
        } else {
          await reject(tx, made.id, input.customerId, 'notification_failed', clock());
        }
      });
      return accepted ? { ok: true, attemptId: made.id } : FAIL;
    },

    /** Issues an email challenge to the customer's OWN verified login email (never a caller-supplied address). */
    async requestEmailChallenge(input: { attemptId: string; sourceKey?: string }): Promise<{ ok: boolean }> {
      if (!config.deliverEmailChallenge) return FAIL;
      const customerId = await customerIdOf(input.attemptId);
      if (!(await allowed('email_challenge', { sourceKey: input.sourceKey, customerId, attemptId: input.attemptId }))) return FAIL;
      const proof = hex(crypto.getRandomValues(new Uint8Array(32)));
      const issued = await config.db.transaction(async (tx) => {
        const attempt = await lockLive(tx, input.attemptId);
        if (!attempt || attempt.status !== 'awaiting_factors' || !attempt.noticeAcceptedAt || attempt.emailFactorAt) return null;
        const recipients = await recipientsOf(tx, attempt.customerId);
        const email = recipients && normalizeLoginEmail(recipients.email);
        if (!email) return null;
        const now = clock();
        const subjectDigest = await customerChallengeDigest({ secret: config.hmacSecret, purpose: EMAIL_CHALLENGE_PURPOSE, field: 'subject', value: email });
        const challenges = new CustomerAuthChallengeRepository(tx);
        if (await challenges.countLive({ customerId: attempt.customerId, purpose: EMAIL_CHALLENGE_PURPOSE, now }) >= MAX_LIVE_EMAIL_CHALLENGES) return null;
        const [recent] = await tx.select({ id: customerAuthChallenges.id }).from(customerAuthChallenges).where(and(
          eq(customerAuthChallenges.purpose, EMAIL_CHALLENGE_PURPOSE), eq(customerAuthChallenges.customerId, attempt.customerId),
          sql`${customerAuthChallenges.createdAt} > ${new Date(now.getTime() - 60_000)}`)).limit(1);
        if (recent) return null;
        const challengeId = await challenges.create({
          customerId: attempt.customerId, purpose: EMAIL_CHALLENGE_PURPOSE, subjectDigest,
          proofDigest: await customerChallengeDigest({ secret: config.hmacSecret, purpose: EMAIL_CHALLENGE_PURPOSE, field: 'proof', value: proof }),
          expiresAt: new Date(now.getTime() + 900_000), now,
        });
        return { challengeId, email };
      });
      if (!issued) return FAIL;
      try {
        await config.deliverEmailChallenge({ recipient: issued.email, challengeId: issued.challengeId, proof });
        return { ok: true };
      } catch { return FAIL; }
    },

    async verifyEmailFactor(input: { attemptId: string; sourceKey?: string; challengeId: string; proof: string }): Promise<RecoveryOutcome> {
      if (!isUuid(input.challengeId) || typeof input.proof !== 'string' || input.proof.length < 6 || input.proof.length > 256) return FAIL;
      return verifyFactor(input.attemptId, input.sourceKey, 'email_verify', 'email', async (tx, attempt, now) => {
        const recipients = await recipientsOf(tx, attempt.customerId);
        const email = recipients && normalizeLoginEmail(recipients.email);
        if (!email) return 'budget';
        const subjectDigest = await customerChallengeDigest({ secret: config.hmacSecret, purpose: EMAIL_CHALLENGE_PURPOSE, field: 'subject', value: email });
        const proofDigest = await customerChallengeDigest({ secret: config.hmacSecret, purpose: EMAIL_CHALLENGE_PURPOSE, field: 'proof', value: input.proof });
        const challenges = new CustomerAuthChallengeRepository(tx);
        const consumed = await challenges.consume({ id: input.challengeId, customerId: attempt.customerId, purpose: EMAIL_CHALLENGE_PURPOSE, subjectDigest, proofDigest, now });
        if (!consumed) {
          await challenges.recordFailedAttempt({ id: input.challengeId, now, scope: { purpose: EMAIL_CHALLENGE_PURPOSE, subjectDigest, customerId: attempt.customerId } });
          return false;
        }
        return true;
      });
    },

    async verifyPhoneFactor(input: { attemptId: string; sourceKey?: string; proof: RecoveryPhoneProof }): Promise<RecoveryOutcome> {
      return recordPhoneProof(input.attemptId, input.sourceKey, input.proof, true);
    },

    /**
     * Sends a one-time code to the customer's OWN verified phone (never a caller-supplied number), only for a live,
     * announced attempt, at most three times per attempt. Records that THIS attempt asked for it.
     */
    async requestPhoneOtp(input: { attemptId: string; sourceKey?: string }): Promise<{ ok: boolean }> {
      if (!config.phoneOtp) return FAIL;
      const customerId = await customerIdOf(input.attemptId);
      if (!(await allowed('phone_otp', { sourceKey: input.sourceKey, customerId, attemptId: input.attemptId }))) return FAIL;
      const phone = await config.db.transaction(async (tx) => {
        const attempt = await lockLive(tx, input.attemptId);
        if (!attempt || attempt.status !== 'awaiting_factors' || !attempt.noticeAcceptedAt || attempt.phoneFactorAt || attempt.phoneOtpRequestCount >= 3) return null;
        const [customer] = await tx.select({ phone: customers.phone, phoneVerifiedAt: customers.phoneVerifiedAt, status: customers.status, isDeleted: customers.isDeleted })
          .from(customers).where(eq(customers.id, attempt.customerId));
        // D6: an unverified phone is never sent a recovery code.
        if (!customer?.phone || !customer.phoneVerifiedAt || !customerMayHaveSession(customer)) return null;
        await tx.update(customerRecoveryAttempts)
          .set({ phoneOtpRequestedAt: sql`now()`, phoneOtpRequestCount: sql`${customerRecoveryAttempts.phoneOtpRequestCount} + 1` })
          .where(eq(customerRecoveryAttempts.id, attempt.id));
        await events(tx).append({ customerId: attempt.customerId, eventType: 'otp_requested', outcome: 'success', reasonCode: 'recovery_phone_otp', now: clock() });
        return customer.phone;
      });
      if (!phone) return FAIL;
      try { await config.phoneOtp.send(phone); return { ok: true }; } catch { return FAIL; }
    },

    /**
     * Checks the code with the provider (outside any transaction) and, only if approved, mints a recovery-purpose proof
     * on the server and records the factor. The check is allowed only if THIS attempt requested a code in the last ten
     * minutes, so a code issued for ordinary sign-in cannot satisfy recovery. A provider error spends no budget; a
     * rejected code spends the attempt's factor budget.
     */
    async verifyPhoneOtp(input: { attemptId: string; sourceKey?: string; code: string }): Promise<RecoveryOutcome> {
      if (!config.phoneOtp || typeof input.code !== 'string' || !/^[0-9]{4,10}$/.test(input.code) || !isUuid(input.attemptId)) return FAIL;
      const customerId = await customerIdOf(input.attemptId);
      if (!(await allowed('phone_factor', { sourceKey: input.sourceKey, customerId, attemptId: input.attemptId }))) return FAIL;
      const [row] = await config.db.select({ phone: customers.phone, phoneVerifiedAt: customers.phoneVerifiedAt })
        .from(customerRecoveryAttempts).innerJoin(customers, eq(customers.id, customerRecoveryAttempts.customerId))
        .where(and(
          eq(customerRecoveryAttempts.id, input.attemptId), eq(customerRecoveryAttempts.status, 'awaiting_factors'),
          sql`${customerRecoveryAttempts.noticeAcceptedAt} IS NOT NULL`, sql`${customerRecoveryAttempts.phoneFactorAt} IS NULL`,
          sql`${customerRecoveryAttempts.expiresAt} > now()`,
          sql`${customerRecoveryAttempts.phoneOtpRequestedAt} > now() - interval '10 minutes'`));
      if (!row?.phone || !row.phoneVerifiedAt) return FAIL;
      let approved: boolean;
      try { approved = await config.phoneOtp.check(row.phone, input.code); } catch { return FAIL; }
      if (!approved) {
        await config.db.transaction(async (tx) => {
          const attempt = await lockLive(tx, input.attemptId);
          if (attempt && attempt.status === 'awaiting_factors') await spendFailure(tx, attempt, 'phone_factor_invalid', clock());
        });
        return FAIL;
      }
      return recordPhoneProof(input.attemptId, input.sourceKey, { phone: row.phone, verifiedAt: clock(), source: 'twilio_verify', purpose: 'account_recovery' }, false);
    },

    async verifyCodeFactor(input: { attemptId: string; sourceKey?: string; code: unknown }): Promise<RecoveryOutcome> {
      return verifyFactor(input.attemptId, input.sourceKey, 'code_verify', 'code', async (tx, attempt, now) => {
        const redeemed = await redeemCode(tx, { customerId: attempt.customerId, code: input.code, now });
        return redeemed.ok;
      });
    },

    /** Single-use, bounded-lifetime cancellation by the attempt-bound token the customer was sent. */
    async cancel(input: { attemptId: string; token: string; sourceKey?: string }): Promise<{ ok: boolean }> {
      const customerId = await customerIdOf(input.attemptId);
      if (!(await allowed('cancel', { sourceKey: input.sourceKey, customerId, attemptId: input.attemptId }))) return FAIL;
      if (!isUuid(input.attemptId) || typeof input.token !== 'string' || !/^[0-9a-f]{64}$/.test(input.token)) return FAIL;
      const digest = await cancelDigest(input.attemptId, input.token);
      const cancelled = await config.db.transaction(async (tx) => {
        const [row] = await tx.update(customerRecoveryAttempts)
          .set({ status: 'cancelled', endedAt: sql`now()`, endedReason: 'cancelled_by_customer' })
          .where(and(eq(customerRecoveryAttempts.id, input.attemptId), eq(customerRecoveryAttempts.cancelDigest, digest),
            sql`${customerRecoveryAttempts.cancelExpiresAt} > now()`, inArray(customerRecoveryAttempts.status, [...NON_TERMINAL])))
          .returning({ customerId: customerRecoveryAttempts.customerId });
        if (!row) return null;
        await events(tx).append({ customerId: row.customerId, eventType: 'recovery_cancelled', outcome: 'success', reasonCode: 'cancelled_by_customer', now: clock() });
        return { customerId: row.customerId, recipients: await recipientsOf(tx, row.customerId) };
      });
      if (!cancelled) return FAIL;
      if (cancelled.recipients && config.notifier) {
        try { await config.notifier({ kind: 'cancelled', attemptId: input.attemptId, recipients: { email: cancelled.recipients.email, phone: cancelled.recipients.phone } }); } catch { /* the cancellation already committed */ }
      }
      return { ok: true };
    },

    /** Replaces the password after every factor, notice and hold requirement holds. Issues NO session. */
    async complete(input: { attemptId: string; newPassword: string; sourceKey?: string }): Promise<{ ok: boolean }> {
      const customerId = await customerIdOf(input.attemptId);
      if (!(await allowed('complete', { sourceKey: input.sourceKey, customerId, attemptId: input.attemptId })) || !customerId) return FAIL;
      if (typeof input.newPassword !== 'string' || !isHashableLength(input.newPassword, config.passwordPolicy.maxLength)) return FAIL;
      const completable = (attemptId: string) => and(
        eq(customerRecoveryAttempts.id, attemptId), inArray(customerRecoveryAttempts.status, ['factors_verified', 'security_hold']),
        sql`${customerRecoveryAttempts.expiresAt} > now()`, sql`${customerRecoveryAttempts.noticeAcceptedAt} IS NOT NULL`,
        sql`(${customerRecoveryAttempts.risk} = 'standard' OR (${customerRecoveryAttempts.holdUntil} <= now() AND ${customerRecoveryAttempts.holdNoticeAcceptedAt} IS NOT NULL))`,
      );
      // Cheap read first so an attempt that cannot complete never buys PBKDF2 work.
      const [ready] = await config.db.select({ id: customerRecoveryAttempts.id }).from(customerRecoveryAttempts).where(completable(input.attemptId));
      const [owner] = await config.db.select({ phone: customers.phone }).from(customers).where(eq(customers.id, customerId));
      if (!ready || !owner || !checkPasswordPolicy(input.newPassword, { phone: owner.phone }, config.passwordPolicy).ok) return FAIL;
      const passwordHash = await config.hasher.hash(normalizePassword(input.newPassword), iterations);

      try {
        const done = await config.db.transaction(async (tx) => {
          const now = clock();
          const [customer] = await tx.select().from(customers).where(eq(customers.id, customerId)).for('update');
          if (!customer || !customerMayHaveSession(customer)) throw new Rejected();
          // The attempt completion is the guard: it succeeds only if every condition still holds at the DATABASE's now().
          const [attempt] = await tx.update(customerRecoveryAttempts)
            .set({ status: 'completed', endedAt: sql`now()`, endedReason: 'completed' })
            .where(completable(input.attemptId)).returning({ customerId: customerRecoveryAttempts.customerId });
          if (!attempt || attempt.customerId !== customerId) throw new Rejected();
          const [credential] = await tx.select({ verifiedAt: customerCredentials.loginEmailVerifiedAt }).from(customerCredentials)
            .where(eq(customerCredentials.customerId, customerId)).for('update');
          if (!credential?.verifiedAt) throw new Rejected();
          if (!(await new CustomerCredentialRepository(tx).change({ customerId, passwordHash, now }))) throw new Rejected();
          const revoked = await new CustomerSessionRepository(tx).revokeAllForCustomer({ customerId, reason: 'recovery', now });
          // The recovery codes may be known to whoever recovered; the customer must issue a new set after signing in.
          await tx.update(customerRecoveryCodeSets).set({ revokedAt: now, revokedReason: 'security' })
            .where(and(eq(customerRecoveryCodeSets.customerId, customerId), isNull(customerRecoveryCodeSets.revokedAt)));
          await events(tx).append({ customerId, eventType: 'recovery_completed', outcome: 'success', reasonCode: 'password_reset', metadata: { session_count: revoked }, now });
          return { recipients: await recipientsOf(tx, customerId) };
        });
        if (done.recipients && config.notifier) {
          try { await config.notifier({ kind: 'completed', attemptId: input.attemptId, recipients: { email: done.recipients.email, phone: done.recipients.phone } }); } catch { /* the reset already committed */ }
        }
        return { ok: true };
      } catch (error) {
        if (error instanceof Rejected) return FAIL;
        throw error;
      }
    },
  };
}

export type CustomerRecoveryService = ReturnType<typeof createCustomerRecoveryService>;
