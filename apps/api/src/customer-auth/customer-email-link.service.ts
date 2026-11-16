import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/client';
import { customerAuthChallenges, customerCredentials, customers, customerSessions } from '../db/schema';
import { PASSWORD_ITERATIONS } from '../auth/password';
import type { Pbkdf2Worker } from '../auth/pbkdf2-worker';
import { CustomerAuthChallengeRepository } from '../repositories/customer-auth-challenge.repository';
import { CustomerAuthEventRepository } from '../repositories/customer-auth-event.repository';
import { CustomerCredentialRepository } from '../repositories/customer-credential.repository';
import { CustomerSessionRepository } from '../repositories/customer-session.repository';
import { customerChallengeDigest, normalizeLoginEmail } from './customer-email-challenge-digest';
import type { RegistrationProofDelivery } from './customer-email-auth.service';
import { checkPasswordPolicy, isHashableLength, normalizePassword, type PasswordPolicyConfig } from './customer-password-policy';
import { customerMayHaveSession, isStepUpFresh, sessionLiveness } from './session-policy';
import { isUuid } from './session-tokens';

const purpose = 'email_link';
const MAX_LIVE_PROOFS = 3;
type Owner = { customerId: string; sessionId: string };

async function lockVerifiedOwner(tx: Transaction, owner: Owner, clock: () => Date) {
  if (!isUuid(owner.customerId) || !isUuid(owner.sessionId)) return null;
  const [customer] = await tx.select().from(customers)
    .where(eq(customers.id, owner.customerId)).for('update');
  if (!customer?.phone || !customer.phoneVerifiedAt || !customerMayHaveSession(customer)) return null;
  const [session] = await tx.select().from(customerSessions).where(and(
    eq(customerSessions.id, owner.sessionId),
    eq(customerSessions.customerId, owner.customerId),
  )).for('update');
  const now = clock();
  if (!session || session.authMethod !== 'otp' || !sessionLiveness(session, now).live ||
      !isStepUpFresh(session.stepUpVerifiedAt, now, 600)) return null;
  return customer;
}

export function createCustomerEmailLinkService(config: {
  db: Database;
  hmacSecret: string;
  hasher: Pbkdf2Worker;
  passwordPolicy: PasswordPolicyConfig;
  deliver?: RegistrationProofDelivery;
  now?: () => Date;
}) {
  const clock = config.now ?? (() => new Date());
  const digest = (field: 'subject' | 'proof', value: string) =>
    customerChallengeDigest({ secret: config.hmacSecret, purpose, field, value });

  return {
    async requestProof(owner: Owner, address: string): Promise<void> {
      const email = normalizeLoginEmail(address);
      const deliver = config.deliver;
      if (!email || !deliver) return;
      const proof = Array.from(crypto.getRandomValues(new Uint8Array(32)),
        (byte) => byte.toString(16).padStart(2, '0')).join('');
      const [subjectDigest, proofDigest] = await Promise.all([
        digest('subject', email), digest('proof', proof),
      ]);
      const id = await config.db.transaction(async (tx) => {
        if (!await lockVerifiedOwner(tx, owner, clock)) return null;
        const now = clock();
        const credentials = new CustomerCredentialRepository(tx);
        if ((await credentials.findByCustomerId(owner.customerId))?.loginEmail ||
            await credentials.findByLoginEmail(email)) return null;
        const [recent] = await tx.select({ id: customerAuthChallenges.id })
          .from(customerAuthChallenges).where(and(
            eq(customerAuthChallenges.purpose, purpose),
            eq(customerAuthChallenges.customerId, owner.customerId),
            eq(customerAuthChallenges.subjectDigest, subjectDigest),
            gt(customerAuthChallenges.createdAt, new Date(now.getTime() - 60_000)),
          )).limit(1);
        if (recent) return null;
        // Bound concurrent proofs per customer so existing-password guesses
        // stay within a few challenges' attempt budgets (F2).
        if (await new CustomerAuthChallengeRepository(tx)
          .countLive({ customerId: owner.customerId, purpose, now }) >= MAX_LIVE_PROOFS) return null;
        return new CustomerAuthChallengeRepository(tx).create({
          customerId: owner.customerId, purpose, subjectDigest, proofDigest,
          expiresAt: new Date(now.getTime() + 900_000), now,
        });
      });
      if (id) await deliver({ recipient: email, challengeId: id, proof });
    },

    async complete(owner: Owner, input: {
      email: string; challengeId: string; proof: string; password: string;
    }): Promise<boolean> {
      const email = normalizeLoginEmail(input.email);
      if (!email || !isUuid(input.challengeId) || input.proof.length < 6 || input.proof.length > 256 ||
          !isHashableLength(input.password, config.passwordPolicy.maxLength)) return false;
      const [subjectDigest, proofDigest] = await Promise.all([
        digest('subject', email), digest('proof', input.proof),
      ]);
      const challengeScope = { purpose, subjectDigest, customerId: owner.customerId } as const;
      const challenges = new CustomerAuthChallengeRepository(config.db);
      const countFailure = () => challenges.recordFailedAttempt({
        id: input.challengeId, now: clock(), scope: challengeScope,
      });
      try {
        // Phase 1: no locks and no open transaction. Cheap checks first so a
        // bad proof never buys password work, then PBKDF2 (F1). Everything read
        // here is revalidated under lock in phase 2.
        if (!isUuid(owner.customerId) || !await challenges.isUsable({
          id: input.challengeId, customerId: owner.customerId, purpose, subjectDigest, proofDigest, now: clock(),
        })) {
          await countFailure();
          return false;
        }
        const [customer] = await config.db.select({ phone: customers.phone }).from(customers)
          .where(eq(customers.id, owner.customerId));
        const snapshot = await new CustomerCredentialRepository(config.db).findByCustomerId(owner.customerId);
        if (!customer?.phone || snapshot?.loginEmail) return false;
        const password = normalizePassword(input.password);
        let newHash: string | null = null;
        if (snapshot) {
          if (!await config.hasher.verify(password, snapshot.passwordHash)) {
            // A wrong existing password spends the proof's bounded attempts (F2).
            await countFailure();
            return false;
          }
        } else {
          if (!checkPasswordPolicy(input.password, { phone: customer.phone }, config.passwordPolicy).ok) return false;
          newHash = await config.hasher.hash(password, PASSWORD_ITERATIONS);
        }

        // Phase 2: short transaction. Ownership, proof, credential state and
        // uniqueness are all revalidated under lock; any throw rolls back the
        // proof consumption, the credential change and the revocation together.
        return await config.db.transaction(async (tx) => {
          if (!await lockVerifiedOwner(tx, owner, clock)) return false;
          const now = clock();
          const txChallenges = new CustomerAuthChallengeRepository(tx);
          const consumed = await txChallenges.consume({
            id: input.challengeId, customerId: owner.customerId, purpose, subjectDigest, proofDigest, now,
          });
          if (!consumed) {
            await txChallenges.recordFailedAttempt({ id: input.challengeId, now, scope: challengeScope });
            return false;
          }

          const [current] = await tx.select().from(customerCredentials)
            .where(eq(customerCredentials.customerId, owner.customerId)).for('update');
          if (current?.loginEmail) throw new Error('Credential already linked');
          if (snapshot) {
            // The password verified in phase 1 must still be the stored one.
            if (!current || current.passwordHash !== snapshot.passwordHash) {
              throw new Error('Credential changed during linking');
            }
            const updated = await tx.update(customerCredentials).set({
              loginEmail: email, loginEmailVerifiedAt: now, updatedAt: now,
              legacyTokensInvalidBefore: sql`GREATEST(${customerCredentials.legacyTokensInvalidBefore}, ${now})`,
            }).where(and(eq(customerCredentials.customerId, owner.customerId), isNull(customerCredentials.loginEmail)))
              .returning({ customerId: customerCredentials.customerId });
            if (updated.length !== 1) throw new Error('Credential link update conflict');
          } else {
            if (current || !newHash) throw new Error('Credential appeared during linking');
            const created = await new CustomerCredentialRepository(tx).create({
              customerId: owner.customerId, passwordHash: newHash, now,
              verifiedLoginEmail: { address: email, verifiedAt: now },
            });
            if (!created) throw new Error('Credential claim conflict');
          }

          const revoked = await new CustomerSessionRepository(tx).revokeAllForCustomer({
            customerId: owner.customerId, reason: 'logout_all', now,
          });
          await new CustomerAuthEventRepository(tx).append({
            customerId: owner.customerId, sessionId: owner.sessionId, eventType: 'session_revoked',
            outcome: 'success', reasonCode: 'email_credential_linked',
            metadata: { session_count: revoked }, now,
          });
          return true;
        });
      } catch {
        return false;
      }
    },
  };
}
