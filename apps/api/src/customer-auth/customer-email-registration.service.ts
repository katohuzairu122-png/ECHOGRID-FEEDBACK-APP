import type { Database } from '../db/client';
import { customers } from '../db/schema';
import { CustomerAuthChallengeRepository } from '../repositories/customer-auth-challenge.repository';
import { CustomerCredentialRepository } from '../repositories/customer-credential.repository';
import { customerChallengeDigest, normalizeLoginEmail } from './customer-email-challenge-digest';
import { normalizeE164 } from '../lib/phone';

/**
 * S2 transactional registration core (NOT mounted or activated).
 * A verified email proof can create one email-only customer and one credential
 * atomically. This does not send challenges, issue sessions or alter existing
 * phone-based identities. Email/phone account linking is a separate verified
 * ownership flow and must never be inferred from profile email.
 */
export type EmailRegistrationResult =
  | { ok: true; customerId: string }
  | { ok: false; kind: 'invalid' };

export async function completeEmailRegistration(input: {
  db: Database;
  hmacSecret: string;
  challengeId: string;
  email: string;
  proof: string;
  passwordHash: string | (() => Promise<string>);
  /**
   * Optional phone given at sign-up. It is stored UNVERIFIED (phone_verified_at stays null): a number someone typed proves
   * nothing, gates nothing and is never used to find or sign in an account until the phone-attach flow verifies it.
   */
  phone?: string | undefined;
  now: Date;
}): Promise<EmailRegistrationResult> {
  const invalid = { ok: false, kind: 'invalid' } as const;
  const phone = input.phone === undefined ? null : normalizeE164(input.phone);
  if (input.phone !== undefined && phone === null) return invalid;
  const email = normalizeLoginEmail(input.email);
  if (
    !email ||
    typeof input.proof !== 'string' ||
    input.proof.length < 6 ||
    input.proof.length > 256 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.challengeId)
  ) return invalid;
  const [subjectDigest, proofDigest] = await Promise.all([
    customerChallengeDigest({ secret: input.hmacSecret, purpose: 'email_registration', field: 'subject', value: email }),
    customerChallengeDigest({ secret: input.hmacSecret, purpose: 'email_registration', field: 'proof', value: input.proof }),
  ]);

  // A failed or conflicting insert throws, rolling back BOTH proof consumption
  // and the customer insert. No identity is created without consuming a proof.
  try {
    return await input.db.transaction(async (tx) => {
      const challenges = new CustomerAuthChallengeRepository(tx);
      const consumed = await challenges.consume({
        id: input.challengeId,
        customerId: null,
        purpose: 'email_registration',
        subjectDigest,
        proofDigest,
        now: input.now,
      });
      if (!consumed) {
        await challenges.recordFailedAttempt({
          id: input.challengeId,
          now: input.now,
          scope: { purpose: 'email_registration', subjectDigest },
        });
        return invalid;
      }
      const passwordHash = typeof input.passwordHash === 'function'
        ? await input.passwordHash()
        : input.passwordHash;
      if (!/^pbkdf2\$[1-9][0-9]*\$[^$]+\$[^$]+$/.test(passwordHash)) {
        throw new Error('Invalid password hash');
      }
      const [customer] = await tx.insert(customers).values({
        phone,
        phoneVerifiedAt: null,
        createdAt: input.now,
        updatedAt: input.now,
      }).returning({ id: customers.id });
      if (!customer) throw new Error('Customer insert returned no row');
      const credentials = new CustomerCredentialRepository(tx);
      const created = await credentials.create({
        customerId: customer.id,
        passwordHash,
        now: input.now,
        verifiedLoginEmail: { address: email, verifiedAt: input.now },
      });
      if (!created) throw new Error('Email credential collision');
      return { ok: true, customerId: customer.id } as const;
    });
  } catch {
    // Unique-email collisions, concurrent registration and database failures
    // have no distinguishing public response. The HTTP layer remains disabled.
    return invalid;
  }
}
