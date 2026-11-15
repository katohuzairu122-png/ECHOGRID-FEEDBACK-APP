import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { CustomerAuthChallengeRepository } from '../../src/repositories/customer-auth-challenge.repository';
import { customerChallengeDigest } from '../../src/customer-auth/customer-email-challenge-digest';
import { completeEmailRegistration } from '../../src/customer-auth/customer-email-registration.service';
import { createEmailRegistrationService, type RegistrationProofDelivery } from '../../src/customer-auth/customer-email-auth.service';
import { pbkdf2Hash } from '../../src/auth/password';

describe.skipIf(!process.env.DATABASE_URL)('S2 email registration transaction (Postgres)', () => {
  const secret = 'integration-only-hmac-key-with-more-than-thirty-two-bytes';
  const email = `s2-tx-${Date.now()}@example.test`;
  const deliveredAddress = `delivery-${email}`;
  let client: Client;
  const challengeIds: string[] = [];
  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.query('DELETE FROM customers WHERE id IN (SELECT customer_id FROM customer_credentials WHERE login_email = ANY($1::text[]))', [[email, deliveredAddress]]);
    await client.query('DELETE FROM customer_auth_challenges WHERE id = ANY($1::uuid[])', [challengeIds]);
    await client.end();
  });

  it('atomically consumes proof, creates an email-only identity, and refuses replay', async () => {
    const db = buildDb(client);
    const now = new Date();
    const proof = 'unique-integration-proof-123456789';
    const challengeId = await new CustomerAuthChallengeRepository(db).create({
      purpose: 'email_registration',
      subjectDigest: await customerChallengeDigest({ secret, purpose: 'email_registration', field: 'subject', value: email }),
      proofDigest: await customerChallengeDigest({ secret, purpose: 'email_registration', field: 'proof', value: proof }),
      expiresAt: new Date(now.getTime() + 300_000),
      now,
    });
    challengeIds.push(challengeId);
    const passwordHash = await pbkdf2Hash('correct horse battery staple', 1000);
    const input = { db, hmacSecret: secret, challengeId, email, proof, passwordHash, now };
    const first = await completeEmailRegistration(input);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Registration did not complete');
    const rows = await client.query(
      'SELECT c.phone, c.phone_verified_at, cc.login_email_verified_at FROM customers c JOIN customer_credentials cc ON cc.customer_id=c.id WHERE c.id=$1',
      [first.customerId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].phone).toBeNull();
    expect(rows.rows[0].phone_verified_at).toBeNull();
    expect(rows.rows[0].login_email_verified_at).not.toBeNull();
    expect(await completeEmailRegistration(input)).toEqual({ ok: false, kind: 'invalid' });
    expect((await client.query('SELECT count(*)::int AS n FROM customer_credentials WHERE login_email=$1', [email])).rows[0].n).toBe(1);
  });

  it('counts five wrong proofs only for the matching registration challenge and subject', async () => {
    const db = buildDb(client);
    const now = new Date();
    const address = `locked-${email}`;
    const proof = 'correct-integration-proof';
    const purpose = 'email_registration';
    const challengeId = await new CustomerAuthChallengeRepository(db).create({
      purpose,
      subjectDigest: await customerChallengeDigest({ secret, purpose, field: 'subject', value: address }),
      proofDigest: await customerChallengeDigest({ secret, purpose, field: 'proof', value: proof }),
      expiresAt: new Date(now.getTime() + 900_000),
      now,
    });
    challengeIds.push(challengeId);
    const passwordHash = await pbkdf2Hash('correct horse battery staple', 1000);
    const input = { db, hmacSecret: secret, challengeId, email: address, proof, passwordHash, now };
    const invalid = { ok: false, kind: 'invalid' };
    const readChallenge = async () => (await client.query(
      'SELECT attempts, consumed_at FROM customer_auth_challenges WHERE id = $1',
      [challengeId],
    )).rows[0];

    expect(await completeEmailRegistration({ ...input, email })).toEqual(invalid);
    expect(await readChallenge()).toEqual({ attempts: 0, consumed_at: null });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await completeEmailRegistration({ ...input, proof: 'wrong-integration-proof' })).toEqual(invalid);
    }
    expect(await completeEmailRegistration(input)).toEqual(invalid);
    expect(await readChallenge()).toEqual({ attempts: 5, consumed_at: null });
  });

  it('issues a digest-only challenge, suppresses resends and completes with the delivered proof', async () => {
    const db = buildDb(client);
    const timestamp = new Date();
    const messages: Array<Parameters<RegistrationProofDelivery>[0]> = [];
    const registration = createEmailRegistrationService({
      db, hmacSecret: secret, now: () => timestamp,
      passwordPolicy: { minLength: 12 },
      hasher: {
        hash: (password) => pbkdf2Hash(password, 1000),
        verify: async () => false,
      },
      deliver: async (message) => { messages.push(message); },
    });
    await registration.requestProof(deliveredAddress);
    await registration.requestProof(deliveredAddress);
    expect(messages).toHaveLength(1);
    const [message] = messages;
    if (!message) throw new Error('Expected a synthetic delivery');
    challengeIds.push(message.challengeId);
    const { rows } = await client.query(
      'SELECT subject_digest, proof_digest, expires_at FROM customer_auth_challenges WHERE id = $1',
      [message.challengeId],
    );
    expect(rows[0].subject_digest).not.toBe(message.recipient);
    expect(rows[0].proof_digest).not.toBe(message.proof);
    expect(rows[0].expires_at.getTime() - timestamp.getTime()).toBe(900_000);
    expect((await registration.completeRegistration({
      email: message.recipient, challengeId: message.challengeId, proof: message.proof,
      password: 'a strong synthetic password',
    })).ok).toBe(true);
  });
});
