import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { CustomerAuthChallengeRepository } from '../../src/repositories/customer-auth-challenge.repository';
import { customerChallengeDigest } from '../../src/customer-auth/customer-email-challenge-digest';
import { completeEmailRegistration } from '../../src/customer-auth/customer-email-registration.service';
import { pbkdf2Hash } from '../../src/auth/password';

describe.skipIf(!process.env.DATABASE_URL)('S2 email registration transaction (Postgres)', () => {
  const secret = 'integration-only-hmac-key-with-more-than-thirty-two-bytes';
  const email = `s2-tx-${Date.now()}@example.test`;
  let client: Client;
  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.query('DELETE FROM customers WHERE id IN (SELECT customer_id FROM customer_credentials WHERE login_email=$1)', [email]);
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
});
