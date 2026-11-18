import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signCustomerAccessToken } from '../../src/customer-auth/customer-jwt';
import { buildDb } from '../../src/db/client';
import type { VelocityKv } from '../../src/fraud/velocity-tracker';
import { signQrToken } from '../../src/qr/qr-token';
import { createRepositories } from '../../src/repositories';
import {
  CUSTOMER_JWT_SECRET,
  QR_TOKEN_SECRET,
  createFakeKv,
  customerRequest,
} from './helpers/customer-http';

/**
 * Split 01: joining a loyalty program requires explicit JOIN_LOYALTY consent, and the SERVER
 * enforces it on both join endpoints. A checkbox in the UI is a convenience; this proves the API
 * refuses a join that was not explicitly accepted (and writes nothing), and that an accepted join
 * records the wording version the customer was shown.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  const target = new URL(databaseUrl);
  if (
    !['localhost', '127.0.0.1'].includes(target.hostname) ||
    !['/echogrid_test', '/echogrid_ci_pg18', '/echogrid_core_loyalty_test'].includes(
      target.pathname,
    )
  ) {
    throw new Error('Join consent test requires a disposable loopback PostgreSQL test database.');
  }
}

const JOIN_ENDPOINTS = ['/customer-memberships/join', '/loyalty/me/join'] as const;

const post = <T = unknown>(token: string, path: string, body: unknown, kv: VelocityKv) =>
  customerRequest<T>(databaseUrl!, token, 'POST', path, body, kv);

describe.skipIf(!databaseUrl)('Join consent contract (real HTTP and disposable PostgreSQL)', () => {
  const run = randomUUID();
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let businessId: string;
  let qrToken: string;

  const newCustomer = async () => {
    const id = (
      await repos.customers.create({
        phone: `+1587${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      })
    ).id;
    return { id, token: await signCustomerAccessToken(id, CUSTOMER_JWT_SECRET) };
  };
  const countFor = async (table: string, customerId: string) =>
    Number(
      (
        await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE customer_id = $1`, [
          customerId,
        ])
      ).rows[0].n,
    );
  const rowCounts = async (customerId: string) => ({
    memberships: await countFor('business_customer_memberships', customerId),
    accounts: await countFor('loyalty_accounts', customerId),
    consents: await countFor('consent_grants', customerId),
  });

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    repos = createRepositories(buildDb(client));
    const staffId = (
      await repos.users.create({
        email: `join-consent-${run}@example.test`,
        fullName: 'Join consent fixture',
        passwordHash: 'test-fixture',
        status: 'active',
      })
    ).id;
    businessId = (
      await repos.businesses.create({ name: 'Join consent', slug: `join-consent-${run}` })
    ).id;
    const branch = await repos.branches.create({
      businessId,
      name: 'Consent branch',
      slug: 'consent-1',
    });
    const qr = await repos.qrCodes.create({
      businessId,
      branchId: branch.id,
      type: 'business',
      createdBy: staffId,
    });
    qrToken = await signQrToken(
      { qrCodeId: qr.id, businessId, branchId: branch.id },
      QR_TOKEN_SECRET,
    );
  });

  afterAll(async () => {
    await client.end();
  });

  describe.each(JOIN_ENDPOINTS)('POST %s', (endpoint) => {
    it.each<[string, Record<string, unknown>]>([
      ['no consentAccepted', {}],
      ['consentAccepted false', { consentAccepted: false }],
      ['consentAccepted as a string', { consentAccepted: 'true' }],
      ['an unknown consent version', { consentAccepted: true, consentVersion: 'v2' }],
    ])('refuses a join with %s and writes nothing', async (_label, extra) => {
      const customer = await newCustomer();

      const response = await post(customer.token, endpoint, { qrToken, ...extra }, createFakeKv());

      expect(response.status).toBe(400);
      expect(response.error?.code).toBe('VALIDATION_ERROR');
      expect(await rowCounts(customer.id)).toEqual({ memberships: 0, accounts: 0, consents: 0 });
    });

    it('records an explicit acceptance as one active join consent carrying the accepted version', async () => {
      const customer = await newCustomer();

      const response = await post(
        customer.token,
        endpoint,
        { qrToken, consentAccepted: true, consentVersion: 'v1' },
        createFakeKv(),
      );

      expect(response.status).toBe(201);
      expect(await rowCounts(customer.id)).toEqual({ memberships: 1, accounts: 1, consents: 1 });
      const grant = (
        await client.query(
          `SELECT purpose, status, consent_version FROM consent_grants
            WHERE customer_id = $1 AND business_id = $2`,
          [customer.id, businessId],
        )
      ).rows[0];
      expect(grant).toEqual({ purpose: 'join_loyalty', status: 'active', consent_version: 'v1' });
    });
  });
});
