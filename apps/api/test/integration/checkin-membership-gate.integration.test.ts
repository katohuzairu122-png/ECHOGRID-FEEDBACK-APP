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
 * Split 01 (finding J): the customer check-in route must gate on an active
 * membership BEFORE it reserves the four-hour KV cooldown. Otherwise a
 * non-member's first scan consumes the cooldown and the "join, then check in"
 * call that follows is answered with the new account unchanged and no points.
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
    throw new Error(
      'Check-in membership gate test requires a disposable loopback PostgreSQL test database.',
    );
  }
}

const post = <T = unknown>(token: string, path: string, body: unknown, kv: VelocityKv) =>
  customerRequest<T>(databaseUrl!, token, 'POST', `/loyalty/me${path}`, body, kv);

describe.skipIf(!databaseUrl)(
  'Check-in membership gate (real HTTP and disposable PostgreSQL)',
  () => {
    let client: Client;
    let repos: ReturnType<typeof createRepositories>;
    let businessId: string;
    let qrToken: string;
    let pointsPerCheckin: number;
    const run = randomUUID();

    const newCustomer = async () => {
      const id = (
        await repos.customers.create({
          phone: `+1587${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
          phoneVerifiedAt: new Date(),
        })
      ).id;
      return { id, token: await signCustomerAccessToken(id, CUSTOMER_JWT_SECRET) };
    };
    const checkinRows = async (customerId: string) =>
      (
        await client.query(
          `SELECT count(*)::int AS n
           FROM loyalty_transactions t
           JOIN loyalty_accounts a ON a.id = t.loyalty_account_id
          WHERE a.customer_id = $1 AND a.business_id = $2 AND t.type = 'checkin'`,
          [customerId, businessId],
        )
      ).rows[0].n as number;

    beforeAll(async () => {
      client = new Client({ connectionString: databaseUrl });
      await client.connect();
      repos = createRepositories(buildDb(client));
      const staffId = (
        await repos.users.create({
          email: `checkin-gate-${run}@example.test`,
          fullName: 'Check-in gate fixture',
          passwordHash: 'test-fixture',
          status: 'active',
        })
      ).id;
      businessId = (
        await repos.businesses.create({ name: 'Check-in gate', slug: `checkin-gate-${run}` })
      ).id;
      const branch = await repos.branches.create({
        businessId,
        name: 'Gate branch',
        slug: 'gate-1',
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
      pointsPerCheckin = (await repos.loyaltySettings.getOrCreateDefaults(businessId))
        .pointsPerCheckin;
    });

    afterAll(async () => {
      await client.end();
    });

    it('rejects a non-member without consuming the cooldown, so join then check-in earns points on the first visit', async () => {
      const kv = createFakeKv();
      const customer = await newCustomer();

      const first = await post(customer.token, '/checkin', { qrToken }, kv);
      expect(first.status).toBe(409);
      expect(first.error?.code).toBe('MEMBERSHIP_REQUIRED');

      const joined = await post(
        customer.token,
        '/join',
        { qrToken, consentAccepted: true, consentVersion: 'v1' },
        kv,
      );
      expect(joined.status).toBe(201);

      const second = await post<{ points: number }>(customer.token, '/checkin', { qrToken }, kv);
      expect(second.status).toBe(200);
      expect(pointsPerCheckin).toBeGreaterThan(0);
      expect(second.data?.points).toBe(pointsPerCheckin);
      expect(await checkinRows(customer.id)).toBe(1);
    });

    it('still blocks a repeat scan by an active member (the cooldown itself is unchanged)', async () => {
      const kv = createFakeKv();
      const customer = await newCustomer();
      await post(
        customer.token,
        '/join',
        { qrToken, consentAccepted: true, consentVersion: 'v1' },
        kv,
      );

      const first = await post<{ points: number }>(customer.token, '/checkin', { qrToken }, kv);
      expect(first.status).toBe(200);
      const repeat = await post<{ points: number }>(customer.token, '/checkin', { qrToken }, kv);
      expect(repeat.status).toBe(200);
      expect(repeat.data?.points).toBe(first.data?.points);
      expect(await checkinRows(customer.id)).toBe(1);
    });
  },
);
