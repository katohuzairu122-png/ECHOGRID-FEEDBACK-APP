import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccessToken, signCashierAccessToken } from '../../src/auth/jwt';
import type { Bindings } from '../../src/config/env';
import { signCustomerAccessToken } from '../../src/customer-auth/customer-jwt';
import { CustomerMembershipService } from '../../src/customer-relationships/customer-membership.service';
import { customerMembershipRoutes } from '../../src/customer-relationships/customer-membership.routes';
import { buildDb } from '../../src/db/client';
import { errorHandler } from '../../src/lib/error-handler';
import { loyaltyCustomerRoutes } from '../../src/loyalty/loyalty-customer.routes';
import { loyaltyRoutes } from '../../src/loyalty/loyalty.routes';
import { auditTrail } from '../../src/middleware/audit';
import { cashierScopeGuard } from '../../src/middleware/cashier-scope';
import { RoleProvisioningService } from '../../src/rbac/role-provisioning.service';
import { createRepositories } from '../../src/repositories';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  const target = new URL(databaseUrl);
  if (!['localhost', '127.0.0.1'].includes(target.hostname) ||
      !['/echogrid_test', '/echogrid_core_loyalty_test'].includes(target.pathname)) {
    throw new Error('Core loyalty acceptance requires a disposable loopback PostgreSQL test database.');
  }
}

const staffSecret = 'core-loyalty-fixture-staff-only';
const customerSecret = 'core-loyalty-fixture-customer-only';
const run = randomUUID();
const allow = { limit: async () => ({ success: true }) };
const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/v1/*', auditTrail, cashierScopeGuard);
app.route('/api/v1/loyalty/me', loyaltyCustomerRoutes);
app.route('/api/v1/loyalty', loyaltyRoutes);
app.route('/api/v1/customer-memberships', customerMembershipRoutes);
app.onError(errorHandler);

type Actor = { token: string; businessId?: string; branchId?: string };
type Envelope<T> = { data?: T; error?: { code: string } };

async function request<T = unknown>(actor: Actor, path: string, body?: unknown) {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers({ Authorization: `Bearer ${actor.token}` });
  if (actor.businessId) headers.set('X-Business-Id', actor.businessId);
  if (actor.branchId) headers.set('X-Branch-Id', actor.branchId);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const env = {
    HYPERDRIVE: { connectionString: databaseUrl },
    JWT_ACCESS_SECRET: staffSecret,
    CUSTOMER_JWT_SECRET: customerSecret,
    QR_TOKEN_SECRET: 'synthetic-phone-lookup-signing-secret',
    CUSTOMER_API_RATE_LIMITER: allow,
    PUBLIC_RATE_LIMITER: allow,
    LOOKUP_RATE_LIMITER: allow,
    JOBS: { send: async () => {}, sendBatch: async () => {} },
  } as unknown as Bindings;
  const response = await app.request(`/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env, {
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
    passThroughOnException: () => {},
    props: {},
  });
  await Promise.all(pending);
  return { status: response.status, ...(await response.json() as Envelope<T>) };
}

describe.skipIf(!databaseUrl)('Core loyalty acceptance (real HTTP and disposable PostgreSQL)', () => {
  let dbClient: Client;
  let repos: ReturnType<typeof createRepositories>;
  let membershipService: CustomerMembershipService;
  let businessA: string;
  let businessB: string;
  let branchA1: string;
  let branchA2: string;
  let branchB: string;
  let customerId: string;
  let unverifiedId: string;
  let outsiderId: string;
  let verifiedPhone: string;
  let unverifiedPhone: string;
  let outsiderPhone: string;
  let customer: Actor;
  let cashier: Actor;
  let expiredCashier: Actor;
  let otherOwner: Actor;
  let manager: Actor;
  let owner: Actor;
  let unauthorized: Actor;
  let accountA: string;
  let accountB: string;

  const join = (id: string, businessId: string, branchId: string) =>
    membershipService.join({
      customerId: id, businessId, onboardingSource: 'integration_test',
      onboardingReference: branchId,
    });
  const q = async (sql: string, values: unknown[]) => (await dbClient.query(sql, values)).rows;

  beforeAll(async () => {
    dbClient = new Client({ connectionString: databaseUrl });
    await dbClient.connect();
    const db = buildDb(dbClient);
    repos = createRepositories(db);
    membershipService = new CustomerMembershipService(db);
    const user = async (name: string) => (await repos.users.create({
      email: `core-${name}-${run}@example.test`, fullName: name, passwordHash: 'test-fixture', status: 'active',
    })).id;
    const ownerId = await user('owner-a');
    const ownerBId = await user('owner-b');
    const managerId = await user('manager-a');
    const cashierId = await user('cashier-a');
    const unauthorizedId = await user('unauthorized');
    businessA = (await repos.businesses.create({ name: 'Core A', slug: `core-a-${run}` })).id;
    businessB = (await repos.businesses.create({ name: 'Core B', slug: `core-b-${run}` })).id;
    branchA1 = (await repos.branches.create({ businessId: businessA, name: 'A1', slug: 'a1' })).id;
    branchA2 = (await repos.branches.create({ businessId: businessA, name: 'A2', slug: 'a2' })).id;
    branchB = (await repos.branches.create({ businessId: businessB, name: 'B1', slug: 'b1' })).id;
    const roleService = new RoleProvisioningService(repos);
    const rolesA = await roleService.seedDefaultRoles(businessA, ownerId);
    const rolesB = await roleService.seedDefaultRoles(businessB, ownerBId);
    const grant = (userId: string, businessId: string, roleId: string, branchId: string | null) =>
      repos.userBusinessRoles.grant({ userId, businessId, branchId, roleId, createdBy: userId });
    await grant(ownerId, businessA, rolesA.Owner, null);
    await grant(ownerBId, businessB, rolesB.Owner, null);
    await grant(managerId, businessA, rolesA.Manager, branchA1);
    await grant(cashierId, businessA, rolesA.Staff, branchA1);
    const web = async (id: string, businessId: string, branchId: string): Promise<Actor> =>
      ({ token: await signAccessToken(id, staffSecret), businessId, branchId });
    owner = await web(ownerId, businessA, branchA2);
    otherOwner = await web(ownerBId, businessB, branchB);
    manager = await web(managerId, businessA, branchA1);
    unauthorized = await web(unauthorizedId, businessA, branchA1);
    const scopedCashier = async (expiresAt: Date): Promise<Actor> => {
      const sessionId = randomUUID();
      await q(
        'INSERT INTO refresh_tokens (user_id, token_hash, session_id, expires_at, client, business_id, branch_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [cashierId, randomUUID(), sessionId, expiresAt, 'cashier', businessA, branchA1],
      );
      return { businessId: businessA, branchId: branchA1,
        token: await signCashierAccessToken(cashierId, staffSecret, { sessionId, businessId: businessA, branchId: branchA1 }) };
    };
    cashier = await scopedCashier(new Date(Date.now() + 3_600_000));
    expiredCashier = await scopedCashier(new Date(Date.now() - 1000));

    const suffix = String(Date.now()).slice(-8);
    verifiedPhone = `+155${suffix}1`;
    unverifiedPhone = `+155${suffix}2`;
    outsiderPhone = `+155${suffix}3`;
    customerId = (await repos.customers.create({ phone: verifiedPhone, phoneVerifiedAt: new Date() })).id;
    unverifiedId = (await repos.customers.create({ phone: unverifiedPhone })).id;
    outsiderId = (await repos.customers.create({ phone: outsiderPhone, phoneVerifiedAt: new Date() })).id;
    customer = { token: await signCustomerAccessToken(customerId, customerSecret) };
    accountA = (await join(customerId, businessA, branchA1)).loyaltyAccount.id;
    accountB = (await join(customerId, businessB, branchB)).loyaltyAccount.id;
    await join(unverifiedId, businessA, branchA1);
    await join(outsiderId, businessB, branchB);
    await repos.communityPointAccounts.create({ customerId, pointsBalance: 73 });
  });

  afterAll(async () => {
    // The disposable CI database is discarded as a unit. Close every connection here.
    await dbClient?.end();
  });

  const snapshot = async () => ({
    accounts: await q('SELECT * FROM loyalty_accounts WHERE business_id = ANY($1::uuid[]) ORDER BY id', [[businessA, businessB]]),
    rewards: await q('SELECT * FROM loyalty_rewards WHERE business_id = ANY($1::uuid[]) ORDER BY id', [[businessA, businessB]]),
    memberships: await q('SELECT * FROM business_customer_memberships WHERE business_id = ANY($1::uuid[]) ORDER BY id', [[businessA, businessB]]),
    purchases: await q('SELECT * FROM loyalty_purchase_events WHERE business_id = ANY($1::uuid[]) ORDER BY id', [[businessA, businessB]]),
    ledger: await q('SELECT t.* FROM loyalty_transactions t JOIN loyalty_accounts a ON a.id=t.loyalty_account_id WHERE a.business_id = ANY($1::uuid[]) ORDER BY t.id', [[businessA, businessB]]),
    community: await repos.communityPointAccounts.findByCustomerId(customerId),
  });
  const expectDenied = async (action: () => Promise<{ status: number }>, status: number) => {
    const before = await snapshot();
    const result = await action();
    expect(await snapshot()).toEqual(before);
    expect(result.status).toBe(status);
  };

  it('enrolls one global customer in two businesses and reuses A membership across branches', async () => {
    expect((await join(customerId, businessA, branchA2)).loyaltyAccount.id).toBe(accountA);
    const membership = await request<unknown[]>(customer, '/customer-memberships');
    expect(membership.status).toBe(200);
    expect(membership.data).toHaveLength(2);
    expect(membership.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ customerId, businessId: businessA }),
      expect.objectContaining({ customerId, businessId: businessB }),
    ]));
    expect((await snapshot()).memberships.filter(row => row.customer_id === customerId)).toHaveLength(2);
    expect(accountA).not.toBe(accountB);
    await expectDenied(() => request({ token: unauthorized.token }, '/customer-memberships/join', {}), 401);
    const unknown = await signCustomerAccessToken(randomUUID(), customerSecret);
    await expectDenied(() => request({ token: unknown }, '/customer-memberships/join', {}), 401);
  });

  it('preserves business and branch boundaries while earning, issuing and redeeming', async () => {
    const lookupPath = '/loyalty/actions/lookup-customer';
    const purchasePath = '/loyalty/actions/lookup-purchase';
    const lookup = await request<{ lookupToken: string }>(cashier, lookupPath, { phone: verifiedPhone });
    expect(lookup.status).toBe(200);
    const lookupToken = lookup.data?.lookupToken;
    if (!lookupToken) throw new Error('Expected scoped phone lookup token');
    await expectDenied(() => request(cashier, lookupPath, { phone: outsiderPhone }), 404);
    await expectDenied(() => request({ ...cashier, branchId: branchA2 }, lookupPath, { phone: verifiedPhone }), 403);
    await expectDenied(() => request(unauthorized, lookupPath, { phone: verifiedPhone }), 403);
    await expectDenied(() => request(expiredCashier, lookupPath, { phone: verifiedPhone }), 401);

    const initial = await snapshot();
    const purchase = { lookupToken, purchaseAmount: 40, idempotencyKey: `purchase-${run}` };
    const replays = await Promise.all([
      request(cashier, purchasePath, purchase), request(cashier, purchasePath, purchase),
    ]);
    expect(replays.map(result => result.status)).toEqual([200, 200]);
    const afterPurchase = await snapshot();
    expect(afterPurchase.purchases).toHaveLength(initial.purchases.length + 1);
    const event = afterPurchase.purchases.find(row => row.idempotency_key === purchase.idempotencyKey);
    expect(event).toMatchObject({ business_id: businessA, branch_id: branchA1, customer_id: customerId });
    expect(afterPurchase.ledger.filter(row => row.purchase_event_id === event?.id)).toEqual([
      expect.objectContaining({ loyalty_account_id: accountA, type: 'purchase', points: 40 }),
    ]);
    await expectDenied(() => request(cashier, purchasePath, { ...purchase, purchaseAmount: 41 }), 409);
    await expectDenied(() => request(otherOwner, purchasePath, purchase), 404);
    await expectDenied(() => request(unauthorized, purchasePath, purchase), 403);

    const bPurchase = await request(otherOwner, `/loyalty/accounts/${accountB}/purchase`, {
      purchaseAmount: 11, idempotencyKey: purchase.idempotencyKey,
    });
    expect(bPurchase.status).toBe(200);
    expect((await snapshot()).purchases.filter(row => row.idempotency_key === purchase.idempotencyKey))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ business_id: businessA, branch_id: branchA1 }),
        expect.objectContaining({ business_id: businessB, branch_id: branchB }),
      ]));

    const issuePath = `/loyalty/me/accounts/${businessA}/issue`;
    const redeemPath = `/loyalty/me/accounts/${businessA}/redeem`;
    const voucher = await repos.loyaltyRewards.create({
      businessId: businessA, name: 'Fixture voucher', type: 'voucher', rewardValue: '5.00',
      cooldownSeconds: 3600, branchId: branchA1, pointsCost: 1,
    });
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA, name: 'Fixture points reward', pointsCost: 10, cooldownSeconds: 3600,
    });
    const expensive = await repos.loyaltyRewards.create({
      businessId: businessA, name: 'Unreachable reward', pointsCost: 1000,
    });
    await expectDenied(() => request(customer, redeemPath, { rewardId: expensive.id }), 422);
    const issued = await request<{ redemptionCode: string }>(customer, issuePath, { rewardId: voucher.id });
    expect(issued.status).toBe(201);
    const code = issued.data?.redemptionCode;
    if (!code) throw new Error('Expected issuance code');
    expect((await snapshot()).ledger.find(row => row.redemption_code === code))
      .toMatchObject({ loyalty_account_id: accountA, points: 0, issuance_status: 'issued' });
    await expectDenied(() => request(customer, issuePath, { rewardId: voucher.id }), 422);
    await expectDenied(() => request(customer, `/loyalty/me/accounts/${businessB}/issue`, { rewardId: voucher.id }), 404);

    const confirm = `/loyalty/redemptions/${code}/confirm`;
    await expectDenied(() => request(unauthorized, confirm, {}), 403);
    await expectDenied(() => request(otherOwner, confirm, {}), 404);
    await expectDenied(() => request(owner, confirm, {}), 422);
    const beforeConfirm = await snapshot();
    expect((await request(manager, confirm, {})).status).toBe(200);
    const confirmed = await snapshot();
    expect(confirmed.accounts).toEqual(beforeConfirm.accounts);
    expect(confirmed.ledger.find(row => row.redemption_code === code))
      .toMatchObject({ issuance_status: 'redeemed', redemption_confirmed_at: expect.any(Date) });
    await expectDenied(() => request(cashier, confirm, {}), 409);

    const redeemed = await request<{ redemptionCode: string }>(customer, redeemPath, { rewardId: reward.id });
    expect(redeemed.status).toBe(201);
    expect((await request(cashier, `/loyalty/redemptions/${redeemed.data?.redemptionCode}/confirm`, {})).status).toBe(200);
    await expectDenied(() => request(customer, redeemPath, { rewardId: reward.id }), 422);
    await expectDenied(() => request(customer, `/loyalty/me/accounts/${businessB}/redeem`, { rewardId: reward.id }), 404);
    const final = await snapshot();
    for (const [id, points] of [[accountA, 30], [accountB, 11]] as const) {
      expect(final.accounts.find(row => row.id === id)?.points).toBe(points);
      expect(final.ledger.filter(row => row.loyalty_account_id === id)
        .reduce((sum, row) => sum + row.points, 0)).toBe(points);
    }
    expect(final.community).toEqual(initial.community);
  });

  it('rolls back purchase and reward mutations when the transaction ledger insert fails', async () => {
    expect((await request(owner, `/loyalty/accounts/${accountA}/purchase`, {
      purchaseAmount: 5, idempotencyKey: `rollback-fixture-${run}`,
    })).status).toBe(200);
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA, name: 'Rollback points reward', pointsCost: 1,
    });
    const voucher = await repos.loyaltyRewards.create({
      businessId: businessA, name: 'Rollback voucher', type: 'voucher', rewardValue: '1.00', pointsCost: 1,
    });
    const name = 'core_acceptance_' + run.replaceAll('-', '');
    await dbClient.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $ BEGIN RAISE EXCEPTION 'synthetic ledger insert failure'; END; $`,
    );
    try {
      await dbClient.query(
        `CREATE TRIGGER ${name} BEFORE INSERT ON loyalty_transactions FOR EACH ROW WHEN (NEW.loyalty_account_id = '${accountA}'::uuid) EXECUTE FUNCTION ${name}()`,
      );
      await expectDenied(() => request(owner, `/loyalty/accounts/${accountA}/purchase`, {
        purchaseAmount: 7, idempotencyKey: `rollback-${run}`,
      }), 500);
      await expectDenied(() => request(customer, `/loyalty/me/accounts/${businessA}/redeem`, {
        rewardId: reward.id,
      }), 500);
      await expectDenied(() => request(customer, `/loyalty/me/accounts/${businessA}/issue`, {
        rewardId: voucher.id,
      }), 500);
    } finally {
      await dbClient.query(`DROP TRIGGER IF EXISTS ${name} ON loyalty_transactions`);
      await dbClient.query(`DROP FUNCTION ${name}()`);
    }
  });

  it('refuses an active member whose phone has never been verified', async () => {
    await expectDenied(() => request(cashier, '/loyalty/actions/lookup-customer', { phone: unverifiedPhone }), 404);
  });
});
