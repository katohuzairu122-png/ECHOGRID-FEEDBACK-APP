import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { customerAuthChallenges } from '../db/schema';
import { PASSWORD_ITERATIONS } from '../auth/password';
import type { Pbkdf2Worker } from '../auth/pbkdf2-worker';
import { CustomerAuthChallengeRepository } from '../repositories/customer-auth-challenge.repository';
import { CustomerCredentialRepository } from '../repositories/customer-credential.repository';
import { customerChallengeDigest, normalizeLoginEmail } from './customer-email-challenge-digest';
import { completeEmailRegistration } from './customer-email-registration.service';
import { checkPasswordPolicy, normalizePassword, type PasswordPolicyConfig } from './customer-password-policy';

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
  const requestProof = async (address: string, next?: string) => {
    const email = normalizeLoginEmail(address);
    if (!email || typeof config.deliver !== 'function') return;
    const subjectDigest = await keyForIdentifier(email);
    const proof = Array.from(crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, '0')).join('');
    const proofDigest = await customerChallengeDigest({
      secret: config.hmacSecret, purpose, field: 'proof', value: proof,
    });
    const challengeId = await config.db.transaction(async (tx) => {
      // Serialize registration issuance by its keyed subject across processes.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${subjectDigest}, 0))`);
      const timestamp = now();
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
      });
    });
    if (challengeId) await config.deliver({ recipient: email, challengeId, proof, ...(next ? { next } : {}) });
  };
  return {
    keyForIdentifier,
    requestProof,
    completeRegistration: async (input: { email: string; challengeId: string; proof: string; name: string; password: string; phone?: string | undefined }) => {
      const name = input.name.trim();
      if (!name || name.length > 120) return { ok: false, kind: 'invalid' } as const;
      if (!checkPasswordPolicy(input.password, { phone: input.phone ?? null }, config.passwordPolicy).ok) {
        return { ok: false, kind: 'invalid' } as const;
      }
      return completeEmailRegistration({
        ...input,
        name,
        db: config.db,
        hmacSecret: config.hmacSecret,
        passwordHash: () => config.hasher.hash(normalizePassword(input.password), PASSWORD_ITERATIONS),
        now: now(),
      });
    },
  };
}
