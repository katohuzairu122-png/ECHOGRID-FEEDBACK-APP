import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { customerAuthChallenges } from '../db/schema';
import { PASSWORD_ITERATIONS } from '../auth/password';
import type { Pbkdf2Worker } from '../auth/pbkdf2-worker';
import { CustomerAuthChallengeRepository } from '../repositories/customer-auth-challenge.repository';
import { CustomerCredentialRepository } from '../repositories/customer-credential.repository';
import { customerChallengeDigest, normalizeLoginEmail } from './customer-email-challenge-digest';
import { completeEmailRegistration } from './customer-email-registration.service';
import { checkPasswordPolicy, normalizePassword, type PasswordPolicyConfig } from './customer-password-policy';
import { sealPendingRegistration, unsealPendingRegistration } from './customer-registration-seal';

const purpose = 'email_registration';

export type RegistrationProofDelivery = (message: {
  recipient: string;
  challengeId: string;
  proof: string;
  next?: string;
}) => Promise<void>;

/** Isolated composition only. The delivery adapter must never log its message. */
export function createEmailRegistrationService(config: {
  db: Database;
  hmacSecret: string;
  passwordPolicy: PasswordPolicyConfig;
  hasher: Pbkdf2Worker;
  deliver: RegistrationProofDelivery;
  now?: () => Date;
}) {
  const now = config.now ?? (() => new Date());
  const keyForIdentifier = (value: string) => customerChallengeDigest({
    secret: config.hmacSecret, purpose, field: 'subject', value,
  });
  const requestProof = async (address: string, next?: string, signup?: { name: string; password: string }) => {
    const email = normalizeLoginEmail(address);
    if (!email || typeof config.deliver !== 'function') return;
    const subjectDigest = await keyForIdentifier(email);
    const proof = Array.from(crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, '0')).join('');
    const proofDigest = await customerChallengeDigest({
      secret: config.hmacSecret, purpose, field: 'proof', value: proof,
    });
    let registrationSealedData: string | undefined;
    if (signup) {
      const name = signup.name.trim();
      if (!name || name.length > 120 || !checkPasswordPolicy(signup.password, { phone: null }, config.passwordPolicy).ok) return;
      // PBKDF2 happens before taking the advisory lock or opening a transaction.
      const passwordHash = await config.hasher.hash(normalizePassword(signup.password), PASSWORD_ITERATIONS);
      registrationSealedData = await sealPendingRegistration({
        secret: config.hmacSecret, subjectDigest, proofDigest,
        record: { email, name, passwordHash },
      });
    }
    const challengeId = await config.db.transaction(async (tx) => {
      // Serialize registration issuance by its keyed subject across processes.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${subjectDigest}, 0))`);
      const timestamp = now();
      // Targeted lazy purge for expired ciphertext belonging to this hashed email.
      await tx.update(customerAuthChallenges).set({ registrationSealedData: null })
        .where(and(eq(customerAuthChallenges.purpose, purpose), eq(customerAuthChallenges.subjectDigest, subjectDigest),
          lte(customerAuthChallenges.expiresAt, timestamp)));
      const [recent] = await tx.select({ id: customerAuthChallenges.id })
        .from(customerAuthChallenges).where(and(
          eq(customerAuthChallenges.purpose, purpose),
          eq(customerAuthChallenges.subjectDigest, subjectDigest),
          isNull(customerAuthChallenges.customerId),
          gt(customerAuthChallenges.createdAt, new Date(timestamp.getTime() - 60_000)),
        )).limit(1);
      if (recent || await new CustomerCredentialRepository(tx).findByLoginEmail(email)) return null;
      return new CustomerAuthChallengeRepository(tx).create({
        purpose, subjectDigest, proofDigest,
        expiresAt: new Date(timestamp.getTime() + 900_000),
        now: timestamp,
        ...(registrationSealedData ? { registrationSealedData } : {}),
      });
    });
    if (challengeId) await config.deliver({ recipient: email, challengeId, proof, ...(next ? { next } : {}) });
  };
  return {
    keyForIdentifier,
    requestProof,
    completeRegistration: async (input: {
      email?: string | undefined; challengeId: string; proof: string; name?: string | undefined; password?: string | undefined; phone?: string | undefined;
    }) => {
      const invalid = { ok: false, kind: 'invalid' } as const;
      const [pending] = await config.db.select({
        subjectDigest: customerAuthChallenges.subjectDigest,
        proofDigest: customerAuthChallenges.proofDigest,
        sealedData: customerAuthChallenges.registrationSealedData,
      }).from(customerAuthChallenges).where(and(
        eq(customerAuthChallenges.id, input.challengeId),
        eq(customerAuthChallenges.purpose, purpose),
        isNull(customerAuthChallenges.customerId),
      )).limit(1);

      if (pending?.sealedData) {
        const proofDigest = await customerChallengeDigest({
          secret: config.hmacSecret, purpose, field: 'proof', value: input.proof,
        });
        const challenges = new CustomerAuthChallengeRepository(config.db);
        if (proofDigest !== pending.proofDigest || !await challenges.isUsable({
          id: input.challengeId, customerId: null, purpose,
          subjectDigest: pending.subjectDigest, proofDigest, now: now(),
        })) {
          await challenges.recordFailedAttempt({
            id: input.challengeId, now: now(), scope: { purpose, subjectDigest: pending.subjectDigest },
          });
          return invalid;
        }
        const sealed = await unsealPendingRegistration({
          secret: config.hmacSecret, subjectDigest: pending.subjectDigest,
          proofDigest: pending.proofDigest, sealed: pending.sealedData,
        });
        if (!sealed || await keyForIdentifier(sealed.email) !== pending.subjectDigest) return invalid;
        return completeEmailRegistration({
          db: config.db, hmacSecret: config.hmacSecret, challengeId: input.challengeId,
          email: sealed.email, name: sealed.name, proof: input.proof,
          passwordHash: sealed.passwordHash, now: now(),
        });
      }

      // Old, still-unexpired challenges created before 0087 are accepted via
      // the original completion contract. They do not have sealed signup fields.
      if (!input.email || !input.name || !input.password) return invalid;
      const name = input.name.trim();
      if (!name || name.length > 120) return invalid;
      if (!checkPasswordPolicy(input.password, { phone: input.phone ?? null }, config.passwordPolicy).ok) return invalid;
      return completeEmailRegistration({
        ...input, email: input.email, name, db: config.db, hmacSecret: config.hmacSecret,
        passwordHash: () => config.hasher.hash(normalizePassword(input.password!), PASSWORD_ITERATIONS),
        now: now(),
      });
    },
  };
}
