import { and, eq, isNull } from 'drizzle-orm';
import type { Database, Transaction } from '../db/client';
import {
  CUSTOMER_RECOVERY_CODE_MAX_FAILED_ATTEMPTS,
  CUSTOMER_RECOVERY_CODE_SET_SIZE,
  customerCredentials,
  customerRecoveryCodes,
  customerRecoveryCodeSets,
  customers,
  customerSessions,
  type CustomerRecoveryCodeRevokedReason,
} from '../db/schema';
import { CustomerAuthEventRepository } from '../repositories/customer-auth-event.repository';
import {
  generateRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_NEVER_MATCHES,
  recoveryCodeVerifier,
} from './customer-recovery-code';
import { customerMayHaveSession, isStepUpFresh, sessionLiveness } from './session-policy';
import { isUuid } from './session-tokens';

/**
 * CUSTOMER-AUTH-S4 recovery-code storage and redemption service. Its methods are
 * exposed only through the gated recovery composition. Possession of a code never
 * authorizes a password change or opens a session; recovery orchestration requires
 * a second independent factor and applies the approved 24-hour high-risk hold.
 *
 * Authorization to issue/rotate/revoke: a LIVE `password`-method session (an
 * email-and-password login, never an `otp` or `recovery` session) whose step-up
 * is fresh, of an active customer who holds a verified login email.
 */
const ATTEMPT_WINDOW_MS = 15 * 60_000;

export type RecoveryCodeOwner = { customerId: string; sessionId: string };
export type IssueRecoveryCodesResult =
  | { ok: true; setId: string; codes: string[] }
  | { ok: false; reason: 'not_authorized' | 'step_up_required' };
export type RevokeRecoveryCodesResult =
  { ok: true; revoked: boolean } | { ok: false; reason: 'not_authorized' | 'step_up_required' };
/** Outward shape is deliberately a bare boolean: one generic failure. */
export type RedeemRecoveryCodeResult = { ok: true } | { ok: false };

/** Single-use redemption inside the CALLER's transaction. Failures are returned (and commit), never thrown. */
export async function redeemInTransactionImpl(
  tx: Transaction,
  customerId: string,
  verifier: string,
  now: Date,
): Promise<RedeemRecoveryCodeResult> {
  const events = new CustomerAuthEventRepository(tx);
  const [customer] = await tx.select().from(customers).where(eq(customers.id, customerId));
  if (!customer || !customerMayHaveSession(customer)) return { ok: false } as const;

  // The set row lock serializes redemptions and rotations for this customer.
  const [set] = await tx
    .select()
    .from(customerRecoveryCodeSets)
    .where(
      and(
        eq(customerRecoveryCodeSets.customerId, customerId),
        isNull(customerRecoveryCodeSets.revokedAt),
      ),
    )
    .for('update');
  if (!set) return { ok: false } as const;

  const windowActive =
    set.attemptsWindowStartedAt !== null &&
    now.getTime() - set.attemptsWindowStartedAt.getTime() < ATTEMPT_WINDOW_MS;
  const failed = windowActive ? set.failedAttempts : 0;
  // Already exhausted: refuse without touching codes and without writing more audit rows.
  if (failed >= CUSTOMER_RECOVERY_CODE_MAX_FAILED_ATTEMPTS) return { ok: false } as const;

  const consumed = await tx
    .update(customerRecoveryCodes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(customerRecoveryCodes.setId, set.id),
        eq(customerRecoveryCodes.customerId, customerId),
        eq(customerRecoveryCodes.verifier, verifier),
        isNull(customerRecoveryCodes.consumedAt),
      ),
    )
    .returning({ id: customerRecoveryCodes.id });

  if (consumed.length === 1) {
    await tx
      .update(customerRecoveryCodeSets)
      .set({ failedAttempts: 0, attemptsWindowStartedAt: null })
      .where(eq(customerRecoveryCodeSets.id, set.id));
    await events.append({
      customerId: customerId,
      eventType: 'recovery_code_redeemed',
      outcome: 'success',
      reasonCode: 'code_redeemed',
      now,
    });
    return { ok: true } as const;
  }

  // Failure: spend budget and record WHY internally. These writes commit (a return, not a throw).
  const [known] = await tx
    .select({
      consumedAt: customerRecoveryCodes.consumedAt,
      revokedAt: customerRecoveryCodeSets.revokedAt,
    })
    .from(customerRecoveryCodes)
    .innerJoin(
      customerRecoveryCodeSets,
      eq(customerRecoveryCodes.setId, customerRecoveryCodeSets.id),
    )
    .where(
      and(
        eq(customerRecoveryCodes.customerId, customerId),
        eq(customerRecoveryCodes.verifier, verifier),
      ),
    );
  const reason = known?.consumedAt
    ? 'code_replayed'
    : known?.revokedAt
      ? 'code_revoked'
      : 'invalid_code';
  const nextFailed = failed + 1;
  await tx
    .update(customerRecoveryCodeSets)
    .set({
      failedAttempts: nextFailed,
      attemptsWindowStartedAt: windowActive ? set.attemptsWindowStartedAt : now,
    })
    .where(eq(customerRecoveryCodeSets.id, set.id));
  const exhausted = nextFailed >= CUSTOMER_RECOVERY_CODE_MAX_FAILED_ATTEMPTS;
  await events.append({
    customerId: customerId,
    eventType: 'recovery_code_failed',
    outcome: exhausted ? 'blocked' : 'failure',
    reasonCode: exhausted ? 'attempts_exhausted' : reason,
    metadata: { attempt: nextFailed },
    now,
  });
  return { ok: false } as const;
}

export function createCustomerRecoveryCodeService(config: {
  db: Database;
  hmacSecret: string;
  stepUpWindowSeconds: number;
  now?: () => Date;
}) {
  const clock = config.now ?? (() => new Date());

  async function authorize(
    tx: Transaction,
    owner: RecoveryCodeOwner,
    now: Date,
  ): Promise<'ok' | 'not_authorized' | 'step_up_required'> {
    if (!isUuid(owner.customerId) || !isUuid(owner.sessionId)) return 'not_authorized';
    const [customer] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, owner.customerId))
      .for('update');
    if (!customer || !customerMayHaveSession(customer)) return 'not_authorized';
    const [session] = await tx
      .select()
      .from(customerSessions)
      .where(
        and(
          eq(customerSessions.id, owner.sessionId),
          eq(customerSessions.customerId, owner.customerId),
        ),
      )
      .for('update');
    if (!session || !sessionLiveness(session, now).live || session.authMethod !== 'password') {
      return 'not_authorized';
    }
    const [credential] = await tx
      .select({ verifiedAt: customerCredentials.loginEmailVerifiedAt })
      .from(customerCredentials)
      .where(eq(customerCredentials.customerId, owner.customerId));
    if (!credential?.verifiedAt) return 'not_authorized';
    if (!isStepUpFresh(session.stepUpVerifiedAt, now, config.stepUpWindowSeconds))
      return 'step_up_required';
    return 'ok';
  }

  async function revokeActive(
    tx: Transaction,
    customerId: string,
    reason: CustomerRecoveryCodeRevokedReason,
    now: Date,
  ): Promise<boolean> {
    const revoked = await tx
      .update(customerRecoveryCodeSets)
      .set({ revokedAt: now, revokedReason: reason })
      .where(
        and(
          eq(customerRecoveryCodeSets.customerId, customerId),
          isNull(customerRecoveryCodeSets.revokedAt),
        ),
      )
      .returning({ id: customerRecoveryCodeSets.id });
    return revoked.length > 0;
  }

  async function verifierFor(customerId: string, code: unknown): Promise<string> {
    const canonical = normalizeRecoveryCode(code);
    return canonical
      ? recoveryCodeVerifier({ secret: config.hmacSecret, customerId, code: canonical })
      : RECOVERY_CODE_NEVER_MATCHES;
  }

  return {
    /**
     * Generates a NEW set and atomically revokes the previous one. Plaintext is
     * returned once. Any failure rolls back, leaving the previous set valid.
     */
    async issue(owner: RecoveryCodeOwner): Promise<IssueRecoveryCodesResult> {
      // Cheap, lock-free work first. Plaintext exists only in this scope and the return value.
      const codes = Array.from({ length: CUSTOMER_RECOVERY_CODE_SET_SIZE }, () =>
        generateRecoveryCode(),
      );
      const verifiers = isUuid(owner.customerId)
        ? await Promise.all(
            codes.map((code) =>
              recoveryCodeVerifier({
                secret: config.hmacSecret,
                customerId: owner.customerId,
                code,
              }),
            ),
          )
        : [];
      return config.db.transaction(async (tx) => {
        const now = clock();
        const decision = await authorize(tx, owner, now);
        if (decision !== 'ok') return { ok: false, reason: decision } as const;
        const rotated = await revokeActive(tx, owner.customerId, 'rotated', now);
        const [set] = await tx
          .insert(customerRecoveryCodeSets)
          .values({
            customerId: owner.customerId,
            createdSessionId: owner.sessionId,
            createdAt: now,
          })
          .returning({ id: customerRecoveryCodeSets.id });
        if (!set) throw new Error('Recovery code set insert returned no row');
        await tx.insert(customerRecoveryCodes).values(
          verifiers.map((verifier, index) => ({
            setId: set.id,
            customerId: owner.customerId,
            position: index + 1,
            verifier,
            createdAt: now,
          })),
        );
        await new CustomerAuthEventRepository(tx).append({
          customerId: owner.customerId,
          sessionId: owner.sessionId,
          eventType: 'recovery_code_issued',
          outcome: 'success',
          reasonCode: rotated ? 'set_rotated' : 'set_created',
          metadata: { state: rotated ? 'rotated' : 'initial' },
          now,
        });
        return { ok: true, setId: set.id, codes } as const;
      });
    },

    /** Authorized revocation of the active set without issuing a replacement. */
    async revoke(owner: RecoveryCodeOwner): Promise<RevokeRecoveryCodesResult> {
      return config.db.transaction(async (tx) => {
        const now = clock();
        const decision = await authorize(tx, owner, now);
        if (decision !== 'ok') return { ok: false, reason: decision } as const;
        const revoked = await revokeActive(tx, owner.customerId, 'customer_revoked', now);
        if (revoked) {
          await new CustomerAuthEventRepository(tx).append({
            customerId: owner.customerId,
            sessionId: owner.sessionId,
            eventType: 'recovery_code_revoked',
            outcome: 'success',
            reasonCode: 'customer_revoked',
            now,
          });
        }
        return { ok: true, revoked } as const;
      });
    },

    /**
     * Single-use redemption of a code of the customer's ACTIVE set. Proves
     * possession only; the caller must still require every other recovery factor.
     * One generic failure outward; reasons are kept apart in the audit trail.
     */
    async redeem(input: { customerId: string; code: unknown }): Promise<RedeemRecoveryCodeResult> {
      if (!isUuid(input.customerId)) return { ok: false };
      const verifier = await verifierFor(input.customerId, input.code);
      return config.db.transaction((tx) =>
        redeemInTransactionImpl(tx, input.customerId, verifier, clock()),
      );
    },
  };
}

export type CustomerRecoveryCodeService = ReturnType<typeof createCustomerRecoveryCodeService>;

/**
 * For the recovery orchestrator (S4-02): redeem inside ITS transaction so a code
 * is consumed if and only if the factor is recorded on the attempt.
 */
export function createRecoveryCodeRedeemer(config: { hmacSecret: string }) {
  return async (
    tx: Transaction,
    input: { customerId: string; code: unknown; now: Date },
  ): Promise<RedeemRecoveryCodeResult> => {
    if (!isUuid(input.customerId)) return { ok: false };
    const canonical = normalizeRecoveryCode(input.code);
    const verifier = canonical
      ? await recoveryCodeVerifier({
          secret: config.hmacSecret,
          customerId: input.customerId,
          code: canonical,
        })
      : RECOVERY_CODE_NEVER_MATCHES;
    return redeemInTransactionImpl(tx, input.customerId, verifier, input.now);
  };
}
