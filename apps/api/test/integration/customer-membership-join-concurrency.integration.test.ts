import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerMembershipService } from '../../src/customer-relationships/customer-membership.service';
import { buildDb } from '../../src/db/client';
import { AppError } from '../../src/lib/errors';
import { createRepositories } from '../../src/repositories';

/**
 * Split 01: joining is idempotent, including under concurrency. Each
 * concurrent call gets its own connection, because transactions on a single
 * pg.Client would interleave instead of racing.
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
      'Join concurrency test requires a disposable loopback PostgreSQL test database.',
    );
  }
}

describe.skipIf(!databaseUrl)(
  'CustomerMembershipService.join idempotency (disposable PostgreSQL)',
  () => {
    const run = randomUUID();
    const clients: Client[] = [];
    let admin: Client;
    let repos: ReturnType<typeof createRepositories>;
    let businessId: string;

    const connect = async () => {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      clients.push(client);
      return client;
    };
    const serviceOnNewConnection = async () =>
      new CustomerMembershipService(buildDb(await connect()));
    const newCustomer = async () =>
      (
        await repos.customers.create({
          phone: `+1587${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
          phoneVerifiedAt: new Date(),
        })
      ).id;
    const join = (service: CustomerMembershipService, customerId: string) =>
      service.join({
        customerId,
        businessId,
        onboardingSource: 'integration_test',
        onboardingReference: `join-idempotency-${run}`,
      });
    const count = async (statement: string, values: unknown[]) =>
      Number((await admin.query(statement, values)).rows[0].n);

    beforeAll(async () => {
      admin = await connect();
      repos = createRepositories(buildDb(admin));
      businessId = (
        await repos.businesses.create({ name: 'Join idempotency', slug: `join-idem-${run}` })
      ).id;
    });

    afterAll(async () => {
      await Promise.all(clients.map((client) => client.end()));
    });

    it('concurrent first joins converge on one membership, one loyalty account and one active consent', async () => {
      const customerId = await newCustomer();
      const services = await Promise.all(Array.from({ length: 6 }, serviceOnNewConnection));

      const results = await Promise.all(services.map((service) => join(service, customerId)));

      expect(new Set(results.map((r) => r.membership.id)).size).toBe(1);
      expect(new Set(results.map((r) => r.loyaltyAccount.id)).size).toBe(1);
      expect(results.every((r) => r.loyaltyAccount.membershipId === r.membership.id)).toBe(true);
      expect(
        await count(
          'SELECT count(*)::int AS n FROM business_customer_memberships WHERE customer_id = $1 AND business_id = $2',
          [customerId, businessId],
        ),
      ).toBe(1);
      expect(
        await count(
          'SELECT count(*)::int AS n FROM loyalty_accounts WHERE customer_id = $1 AND business_id = $2',
          [customerId, businessId],
        ),
      ).toBe(1);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM consent_grants
          WHERE customer_id = $1 AND business_id = $2 AND purpose = 'join_loyalty' AND status = 'active'`,
          [customerId, businessId],
        ),
      ).toBe(1);
    });

    it('replaying a completed join returns the same membership and account without new rows', async () => {
      const customerId = await newCustomer();
      const service = await serviceOnNewConnection();

      const first = await join(service, customerId);
      const replay = await join(service, customerId);

      expect(replay.membership.id).toBe(first.membership.id);
      expect(replay.loyaltyAccount.id).toBe(first.loyaltyAccount.id);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM consent_grants
          WHERE customer_id = $1 AND business_id = $2 AND purpose = 'join_loyalty'`,
          [customerId, businessId],
        ),
      ).toBe(1);
    });

    it('answers a closed (soft-deleted) legacy account with a clean 409 instead of a raw database error', async () => {
      const customerId = await newCustomer();
      const membership = await repos.customerMemberships.create({
        customerId,
        businessId,
        status: 'active',
        onboardingSource: 'legacy_migration',
        onboardingReference: 'fixture',
      });
      const account = await repos.loyaltyAccounts.create({
        customerId,
        businessId,
        membershipId: membership.id,
      });
      await admin.query('UPDATE loyalty_accounts SET is_deleted = true WHERE id = $1', [
        account.id,
      ]);
      const service = await serviceOnNewConnection();

      const failure = await join(service, customerId).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(AppError);
      expect((failure as AppError).status).toBe(409);
      expect((failure as AppError).code).toBe('LOYALTY_ACCOUNT_UNAVAILABLE');
      expect(
        await count(
          'SELECT count(*)::int AS n FROM business_customer_memberships WHERE customer_id = $1 AND business_id = $2',
          [customerId, businessId],
        ),
      ).toBe(1);
    });
  },
);
