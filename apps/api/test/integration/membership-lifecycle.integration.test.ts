import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signCustomerAccessToken } from '../../src/customer-auth/customer-jwt';
import { buildDb } from '../../src/db/client';
import type { VelocityKv } from '../../src/fraud/velocity-tracker';
import { LoyaltyAccountService } from '../../src/loyalty/loyalty-account.service';
import { signQrToken } from '../../src/qr/qr-token';
import { createRepositories } from '../../src/repositories';
import {
  CUSTOMER_JWT_SECRET,
  QR_TOKEN_SECRET,
  createFakeKv,
  customerRequest,
} from './helpers/customer-http';

/**
 * Split 01 lifecycle, over real HTTP and a disposable PostgreSQL database:
 *
 *  - a customer can leave a program; that ends earning and redeeming, withdraws the join consent and
 *    keeps the points, and re-joining with fresh consent restores them;
 *  - withdrawing the join consent ends the membership the same way, every other consent does not;
 *  - customers can only act on their own membership and consent;
 *  - suspended, closed, exited and pending memberships, and a suspended account, are refused on
 *    check-in, redeem and issue with a code that says what the customer can do;
 *  - a redemption that races a leave is ordered by the membership row lock.
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
      'Membership lifecycle test requires a disposable loopback PostgreSQL test database.',
    );
  }
}

const post = <T = unknown>(
  token: string,
  path: string,
  body?: unknown,
  kv: VelocityKv = createFakeKv(),
) => customerRequest<T>(databaseUrl!, token, 'POST', path, body, kv);

describe.skipIf(!databaseUrl)('Membership lifecycle (real HTTP and disposable PostgreSQL)', () => {
  const run = randomUUID();
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let accounts: LoyaltyAccountService;
  let staffId: string;
  let businessId: string;
  let qrToken: string;
  let pointsRewardId: string;
  let voucherId: string;

  const leavePath = () => `/customer-memberships/${businessId}/leave`;
  const redeemPath = () => `/loyalty/me/accounts/${businessId}/redeem`;
  const issuePath = () => `/loyalty/me/accounts/${businessId}/issue`;

  const newCustomer = async () => {
    const id = (
      await repos.customers.create({
        phone: `+1587${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      })
    ).id;
    return { id, token: await signCustomerAccessToken(id, CUSTOMER_JWT_SECRET) };
  };
  type Customer = Awaited<ReturnType<typeof newCustomer>>;

  const join = (customer: Customer, extra: Record<string, unknown> = {}) =>
    post<{
      membership: { id: string; status: string };
      loyaltyAccount: { id: string; points: number };
    }>(customer.token, '/customer-memberships/join', {
      qrToken,
      consentAccepted: true,
      consentVersion: 'v1',
      ...extra,
    });

  const membershipRow = async (customerId: string) =>
    (
      await client.query(
        `SELECT id, status, left_at FROM business_customer_memberships
          WHERE customer_id = $1 AND business_id = $2`,
        [customerId, businessId],
      )
    ).rows[0] as { id: string; status: string; left_at: Date | null };
  const joinConsentStates = async (customerId: string) =>
    (
      await client.query(
        `SELECT status FROM consent_grants
          WHERE customer_id = $1 AND business_id = $2 AND purpose = 'join_loyalty'
          ORDER BY granted_at, created_at`,
        [customerId, businessId],
      )
    ).rows.map((row) => row.status as string);
  const activeJoinConsentId = async (customerId: string) =>
    (
      await client.query(
        `SELECT id FROM consent_grants
          WHERE customer_id = $1 AND business_id = $2 AND purpose = 'join_loyalty' AND status = 'active'`,
        [customerId, businessId],
      )
    ).rows[0].id as string;
  const accountRow = async (customerId: string) =>
    (
      await client.query(
        `SELECT id, points, status FROM loyalty_accounts WHERE customer_id = $1 AND business_id = $2`,
        [customerId, businessId],
      )
    ).rows[0] as { id: string; points: number; status: string };
  const ledgerCount = async (accountId: string) =>
    Number(
      (
        await client.query(
          `SELECT count(*)::int AS n FROM loyalty_transactions WHERE loyalty_account_id = $1`,
          [accountId],
        )
      ).rows[0].n,
    );
  const setMembershipStatus = (customerId: string, status: string) =>
    client.query(
      `UPDATE business_customer_memberships SET status = $3, updated_at = now()
        WHERE customer_id = $1 AND business_id = $2`,
      [customerId, businessId, status],
    );

  /** A customer who joined through the real endpoint, with `points` on the account. */
  const memberWithPoints = async (points: number) => {
    const customer = await newCustomer();
    expect((await join(customer)).status).toBe(201);
    const accountId = (await accountRow(customer.id)).id;
    if (points > 0) {
      await accounts.adjustPoints(businessId, accountId, points, 'lifecycle fixture', staffId);
    }
    return { ...customer, accountId };
  };

  /** The three customer actions that earn or spend, each with a valid body. */
  const earnAndSpendRequests = (): Array<[label: string, path: string, body: unknown]> => [
    ['check-in', '/loyalty/me/checkin', { qrToken }],
    ['redeem', redeemPath(), { rewardId: pointsRewardId }],
    ['issue', issuePath(), { rewardId: voucherId }],
  ];
  const expectAllRefused = async (
    customer: Customer & { accountId: string },
    status: number,
    code: string,
  ) => {
    const ledgerBefore = await ledgerCount(customer.accountId);
    const pointsBefore = (await accountRow(customer.id)).points;
    for (const [label, path, body] of earnAndSpendRequests()) {
      const response = await post(customer.token, path, body);
      expect(response.status, label).toBe(status);
      expect(response.error?.code, label).toBe(code);
    }
    expect(await ledgerCount(customer.accountId)).toBe(ledgerBefore);
    expect((await accountRow(customer.id)).points).toBe(pointsBefore);
  };

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const db = buildDb(client);
    repos = createRepositories(db);
    accounts = new LoyaltyAccountService(db);
    staffId = (
      await repos.users.create({
        email: `lifecycle-${run}@example.test`,
        fullName: 'Lifecycle fixture',
        passwordHash: 'test-fixture',
        status: 'active',
      })
    ).id;
    businessId = (
      await repos.businesses.create({ name: 'Membership lifecycle', slug: `lifecycle-${run}` })
    ).id;
    const branch = await repos.branches.create({
      businessId,
      name: 'Lifecycle branch',
      slug: 'lifecycle-1',
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
    pointsRewardId = (
      await repos.loyaltyRewards.create({ businessId, name: 'Lifecycle coffee', pointsCost: 10 })
    ).id;
    voucherId = (
      await repos.loyaltyRewards.create({
        businessId,
        name: 'Lifecycle voucher',
        type: 'voucher',
        rewardValue: '5.00',
      })
    ).id;
  });

  afterAll(async () => {
    await client.end();
  });

  describe('leaving', () => {
    it('ends the membership and the join consent, keeps the points, and re-joining restores them', async () => {
      const member = await memberWithPoints(50);
      const before = await post<{ remainingBalance: number }>(member.token, redeemPath(), {
        rewardId: pointsRewardId,
      });
      expect(before.status).toBe(201);
      expect(before.data?.remainingBalance).toBe(40);

      const left = await post<{ status: string; leftAt: string | null; businessId: string }>(
        member.token,
        leavePath(),
      );

      expect(left.status).toBe(200);
      expect(left.data).toMatchObject({ status: 'left', businessId });
      expect(left.data?.leftAt).toEqual(expect.any(String));
      const row = await membershipRow(member.id);
      expect(row.status).toBe('left');
      expect(row.left_at).toBeInstanceOf(Date);
      expect(await joinConsentStates(member.id)).toEqual(['revoked']);
      expect(await accountRow(member.id)).toMatchObject({ id: member.accountId, points: 40 });

      const again = await join(member);

      expect(again.status).toBe(201);
      expect(again.data?.membership.status).toBe('active');
      expect(again.data?.loyaltyAccount).toMatchObject({ id: member.accountId, points: 40 });
      expect((await membershipRow(member.id)).left_at).toBeNull();
      expect(await joinConsentStates(member.id)).toEqual(['revoked', 'active']);
      const redeemed = await post<{ remainingBalance: number }>(member.token, redeemPath(), {
        rewardId: pointsRewardId,
      });
      expect(redeemed.status).toBe(201);
      expect(redeemed.data?.remainingBalance).toBe(30);
    });

    it('is idempotent: leaving twice is the same as leaving once', async () => {
      const member = await memberWithPoints(0);

      const first = await post<{ leftAt: string }>(member.token, leavePath());
      const second = await post<{ status: string; leftAt: string }>(member.token, leavePath());

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.data?.status).toBe('left');
      expect(second.data?.leftAt).toBe(first.data?.leftAt);
      expect(await joinConsentStates(member.id)).toEqual(['revoked']);
    });

    it('stops check-in, redemption and issuance with MEMBERSHIP_REQUIRED, and writes nothing', async () => {
      const member = await memberWithPoints(30);
      expect((await post(member.token, leavePath())).status).toBe(200);

      await expectAllRefused(member, 409, 'MEMBERSHIP_REQUIRED');
    });

    it('lets a legacy member (no consent record) leave, and records consent only when they explicitly re-join', async () => {
      const customer = await newCustomer();
      const membership = await repos.customerMemberships.create({
        customerId: customer.id,
        businessId,
        status: 'active',
        onboardingSource: 'legacy_migration',
        onboardingReference: run,
      });
      await repos.loyaltyAccounts.create({
        customerId: customer.id,
        businessId,
        membershipId: membership.id,
      });
      expect(await joinConsentStates(customer.id)).toEqual([]);

      const left = await post<{ status: string }>(customer.token, leavePath());

      expect(left.status).toBe(200);
      expect(left.data?.status).toBe('left');
      expect(await joinConsentStates(customer.id)).toEqual([]);

      expect((await join(customer)).status).toBe(201);
      expect(await joinConsentStates(customer.id)).toEqual(['active']);
    });

    it('refuses a replay of the original join request after the customer left, instead of reviving the membership without consent', async () => {
      const customer = await newCustomer();
      const key = `lifecycle-${randomUUID()}`;
      expect((await join(customer, { idempotencyKey: key })).status).toBe(201);
      expect((await post(customer.token, leavePath())).status).toBe(200);

      const replay = await join(customer, { idempotencyKey: key });

      expect(replay.status).toBe(409);
      expect(replay.error?.code).toBe('CONSENT_IDEMPOTENCY_CONFLICT');
      expect((await membershipRow(customer.id)).status).toBe('left');
      expect(await joinConsentStates(customer.id)).toEqual(['revoked']);

      expect((await join(customer, { idempotencyKey: `${key}-again` })).status).toBe(201);
      expect((await membershipRow(customer.id)).status).toBe('active');
    });

    it('treats a malformed business id as not found rather than a server error', async () => {
      const customer = await newCustomer();

      const response = await post(customer.token, '/customer-memberships/not-a-uuid/leave');

      expect(response.status).toBe(404);
      expect(response.error?.code).toBe('CUSTOMER_MEMBERSHIP_NOT_FOUND');
    });
  });

  describe('withdrawing consent', () => {
    it('ends the membership when the join consent is revoked, keeping the points', async () => {
      const member = await memberWithPoints(20);
      const grantId = await activeJoinConsentId(member.id);

      const revoked = await post(member.token, `/consents/${grantId}/revoke`);

      expect(revoked.status).toBe(200);
      expect(revoked.data).toEqual({ revoked: true });
      expect((await membershipRow(member.id)).status).toBe('left');
      expect(await joinConsentStates(member.id)).toEqual(['revoked']);
      expect((await accountRow(member.id)).points).toBe(20);
      await expectAllRefused(member, 409, 'MEMBERSHIP_REQUIRED');

      const second = await post(member.token, `/consents/${grantId}/revoke`);
      expect(second.status).toBe(404);
      expect(second.error?.code).toBe('CONSENT_GRANT_NOT_ACTIVE');
    });

    it('leaves the membership alone when a different consent is revoked', async () => {
      const member = await memberWithPoints(0);
      const marketing = await repos.consentGrants.create({
        customerId: member.id,
        businessId,
        purpose: 'marketing',
        consentVersion: 'v1',
        status: 'active',
      });

      const revoked = await post(member.token, `/consents/${marketing.id}/revoke`);

      expect(revoked.status).toBe(200);
      expect((await membershipRow(member.id)).status).toBe('active');
      expect(await joinConsentStates(member.id)).toEqual(['active']);
    });
  });

  describe('ownership', () => {
    it('does not let a customer leave, or withdraw consent for, someone else’s membership', async () => {
      const owner = await memberWithPoints(5);
      const intruder = await newCustomer();
      const ownerGrantId = await activeJoinConsentId(owner.id);

      const leave = await post(intruder.token, leavePath());
      expect(leave.status).toBe(404);
      expect(leave.error?.code).toBe('CUSTOMER_MEMBERSHIP_NOT_FOUND');

      const revoke = await post(intruder.token, `/consents/${ownerGrantId}/revoke`);
      expect(revoke.status).toBe(404);
      expect(revoke.error?.code).toBe('CONSENT_GRANT_NOT_ACTIVE');

      expect((await membershipRow(owner.id)).status).toBe('active');
      expect(await joinConsentStates(owner.id)).toEqual(['active']);
    });
  });

  describe('refusals that are not the customer’s to fix', () => {
    it('refuses a suspended membership with 403 MEMBERSHIP_SUSPENDED; it cannot be left or re-joined', async () => {
      const member = await memberWithPoints(30);
      await setMembershipStatus(member.id, 'suspended');

      await expectAllRefused(member, 403, 'MEMBERSHIP_SUSPENDED');

      const leave = await post(member.token, leavePath());
      expect(leave.status).toBe(409);
      expect(leave.error?.code).toBe('MEMBERSHIP_NOT_LEAVABLE');
      const rejoin = await join(member);
      expect(rejoin.status).toBe(409);
      expect(rejoin.error?.code).toBe('MEMBERSHIP_NOT_REACTIVATABLE');
      expect((await membershipRow(member.id)).status).toBe('suspended');
      expect(await joinConsentStates(member.id)).toEqual(['active']);
    });

    it('refuses a suspended loyalty account even though the membership is active', async () => {
      const member = await memberWithPoints(30);
      await client.query(`UPDATE loyalty_accounts SET status = 'suspended' WHERE id = $1`, [
        member.accountId,
      ]);

      await expectAllRefused(member, 403, 'MEMBERSHIP_SUSPENDED');
    });

    it.each(['business_exited', 'closed', 'pending'] as const)(
      'refuses a %s membership as MEMBERSHIP_UNAVAILABLE and does not let the customer leave it',
      async (status) => {
        const member = await memberWithPoints(10);
        await setMembershipStatus(member.id, status);

        await expectAllRefused(member, 409, 'MEMBERSHIP_UNAVAILABLE');

        const leave = await post(member.token, leavePath());
        expect(leave.status).toBe(409);
        expect(leave.error?.code).toBe('MEMBERSHIP_NOT_LEAVABLE');
        expect((await membershipRow(member.id)).status).toBe(status);
      },
    );
  });

  describe('concurrency', () => {
    it('orders a redemption that races a leave: it waits for the leave and is then refused', async () => {
      const member = await memberWithPoints(30);
      const locker = new Client({ connectionString: databaseUrl });
      await locker.connect();
      try {
        // Hold the membership row exactly as an in-flight leave does: an uncommitted UPDATE.
        await locker.query('BEGIN');
        await locker.query(
          `UPDATE business_customer_memberships
              SET status = 'left', left_at = now(), updated_at = now()
            WHERE customer_id = $1 AND business_id = $2`,
          [member.id, businessId],
        );

        let settled = false;
        const redeem = post<{ redemptionCode: string }>(member.token, redeemPath(), {
          rewardId: pointsRewardId,
        }).then((response) => {
          settled = true;
          return response;
        });
        await new Promise((resolve) => setTimeout(resolve, 750));
        expect(settled).toBe(false);

        await locker.query('COMMIT');
        const response = await redeem;

        expect(response.status).toBe(409);
        expect(response.error?.code).toBe('MEMBERSHIP_REQUIRED');
      } finally {
        // Closing the connection rolls back anything still open if an assertion above failed.
        await locker.end();
      }
      expect((await accountRow(member.id)).points).toBe(30);
      expect(await ledgerCount(member.accountId)).toBe(1);
    });
  });
});
