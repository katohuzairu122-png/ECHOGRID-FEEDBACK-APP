import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Bindings } from '../../src/config/env';
import { signCustomerAccessToken } from '../../src/customer-auth/customer-jwt';
import { buildDb } from '../../src/db/client';
import type { VelocityKv } from '../../src/fraud/velocity-tracker';
import { errorHandler } from '../../src/lib/error-handler';
import { loyaltyCustomerRoutes } from '../../src/loyalty/loyalty-customer.routes';
import { signQrToken } from '../../src/qr/qr-token';
import { createRepositories } from '../../src/repositories';

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

const customerSecret = 'checkin-gate-fixture-customer-only';
const qrSecret = 'checkin-gate-fixture-qr-secret-do-not-use';
const allow = { limit: async () => ({ success: true }) };

const app = new Hono<{ Bindings: Bindings }>();
app.route('/api/v1/loyalty/me', loyaltyCustomerRoutes);
app.onError(errorHandler);

type Envelope<T> = { data?: T; error?: { code: string } };

/** In-memory stand-in for the CACHE binding, shared across the calls of one test. */
function createFakeKv(): VelocityKv {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() / 1000 >= entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key: string, value: string, options: { expirationTtl: number }) {
      store.set(key, { value, expiresAt: Date.now() / 1000 + options.expirationTtl });
    },
  };
}

async function post<T = unknown>(token: string, path: string, body: unknown, kv: VelocityKv) {
  const pending: Promise<unknown>[] = [];
  const env = {
    HYPERDRIVE: { connectionString: databaseUrl },
    CUSTOMER_JWT_SECRET: customerSecret,
    QR_TOKEN_SECRET: qrSecret,
    FRAUD_DETECTION_SALT: 'checkin-gate-fixture-salt-do-not-use-in-production',
    CACHE: kv,
    CUSTOMER_API_RATE_LIMITER: allow,
    PUBLIC_RATE_LIMITER: allow,
    JOBS: { send: async () => {}, sendBatch: async () => {} },
  } as unknown as Bindings;
  const response = await app.request(
    `/api/v1/loyalty/me${path}`,
    {
      method: 'POST',
      headers: new Headers({
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(body),
    },
    env,
    {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      passThroughOnException: () => {},
      props: {},
    },
  );
  await Promise.all(pending);
  return { status: response.status, ...((await response.json()) as Envelope<T>) };
}

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
      return { id, token: await signCustomerAccessToken(id, customerSecret) };
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
      qrToken = await signQrToken({ qrCodeId: qr.id, businessId, branchId: branch.id }, qrSecret);
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

      const joined = await post(customer.token, '/join', { qrToken, consentVersion: 'v1' }, kv);
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
      await post(customer.token, '/join', { qrToken, consentVersion: 'v1' }, kv);

      const first = await post<{ points: number }>(customer.token, '/checkin', { qrToken }, kv);
      expect(first.status).toBe(200);
      const repeat = await post<{ points: number }>(customer.token, '/checkin', { qrToken }, kv);
      expect(repeat.status).toBe(200);
      expect(repeat.data?.points).toBe(first.data?.points);
      expect(await checkinRows(customer.id)).toBe(1);
    });
  },
);
