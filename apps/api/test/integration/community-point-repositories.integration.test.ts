import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';

async function expectUniqueViolation(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error('Expected a PostgreSQL unique-constraint violation.');
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    expect(cause?.code).toBe('23505');
  }
}

describe.skipIf(!process.env.DATABASE_URL)('Split 05 Community repositories (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let customerId: string;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));

    const customer = await repos.customers.create({
      phone: `+1556${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
      phoneVerifiedAt: new Date(),
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    await client.end();
  });

  it('persists one Community membership and one account per global customer', async () => {
    const membership = await repos.communityMemberships.create({
      customerId,
      status: 'active',
      policyVersion: 'community-v1',
    });
    expect(membership.customerId).toBe(customerId);
    expect((await repos.communityMemberships.findActiveByCustomerId(customerId))?.id).toBe(
      membership.id,
    );

    await expectUniqueViolation(
      repos.communityMemberships.create({
        customerId,
        status: 'active',
        policyVersion: 'community-v1',
      }),
    );

    const left = await repos.communityMemberships.updateStatus(customerId, {
      status: 'left',
      leftAt: new Date(),
    });
    expect(left?.status).toBe('left');
    expect(await repos.communityMemberships.findActiveByCustomerId(customerId)).toBeUndefined();

    const account = await repos.communityPointAccounts.create({
      customerId,
      status: 'active',
    });
    expect(account.pointsBalance).toBe(0);

    await expectUniqueViolation(
      repos.communityPointAccounts.create({
        customerId,
        status: 'active',
      }),
    );
  });

  it('enforces global/scoped rule versions and resolves only active in-window rules', async () => {
    const globalV1 = await repos.communityPointRules.create({
      sourceType: 'survey_completion',
      version: 1,
      status: 'draft',
      points: 50,
    });

    await expectUniqueViolation(
      repos.communityPointRules.create({
        sourceType: 'survey_completion',
        version: 1,
        status: 'draft',
        points: 75,
      }),
    );

    const activated = await repos.communityPointRules.updateLifecycle(globalV1.id, {
      status: 'active',
      activatedAt: new Date(),
    });
    expect(activated?.status).toBe('active');

    const activeGlobal = await repos.communityPointRules.findActiveForResource(
      'survey_completion',
      null,
      null,
    );
    expect(activeGlobal?.id).toBe(globalV1.id);

    const campaignId = crypto.randomUUID();
    const scoped = await repos.communityPointRules.create({
      sourceType: 'survey_completion',
      resourceType: 'survey_campaign',
      resourceId: campaignId,
      version: 1,
      status: 'draft',
      points: 100,
    });
    expect(
      (
        await repos.communityPointRules.findLatestVersion(
          'survey_completion',
          'survey_campaign',
          campaignId,
        )
      )?.id,
    ).toBe(scoped.id);

    await expectUniqueViolation(
      repos.communityPointRules.create({
        sourceType: 'survey_completion',
        resourceType: 'survey_campaign',
        resourceId: campaignId,
        version: 1,
        status: 'draft',
        points: 125,
      }),
    );
  });

  it('persists idempotent award decisions and append-only Community Point transactions', async () => {
    const account = await repos.communityPointAccounts.findByCustomerId(customerId);
    expect(account).toBeDefined();

    const rule = await repos.communityPointRules.findActiveForResource(
      'survey_completion',
      null,
      null,
    );
    expect(rule).toBeDefined();

    const sourceRef = crypto.randomUUID();
    const firstDecision = await repos.communityPointAwardDecisions.createIdempotent({
      customerId,
      accountId: account!.id,
      sourceType: 'survey_completion',
      sourceRef,
      ruleId: rule!.id,
      status: 'pending_membership',
      points: rule!.points,
    });
    const replayDecision = await repos.communityPointAwardDecisions.createIdempotent({
      customerId,
      accountId: account!.id,
      sourceType: 'survey_completion',
      sourceRef,
      ruleId: rule!.id,
      status: 'pending_membership',
      points: rule!.points,
    });
    expect(firstDecision.inserted).toBe(true);
    expect(replayDecision.inserted).toBe(false);
    expect(replayDecision.decision.id).toBe(firstDecision.decision.id);

    const earnKey = crypto.randomUUID();
    const firstEarn = await repos.communityPointTransactions.createIdempotent({
      accountId: account!.id,
      customerId,
      type: 'earn',
      points: rule!.points,
      sourceType: 'survey_completion',
      sourceRef,
      ruleId: rule!.id,
      awardDecisionId: firstDecision.decision.id,
      idempotencyKey: earnKey,
    });
    const replayEarn = await repos.communityPointTransactions.createIdempotent({
      accountId: account!.id,
      customerId,
      type: 'earn',
      points: rule!.points,
      sourceType: 'survey_completion',
      sourceRef,
      ruleId: rule!.id,
      awardDecisionId: firstDecision.decision.id,
      idempotencyKey: earnKey,
    });
    expect(firstEarn.inserted).toBe(true);
    expect(replayEarn.inserted).toBe(false);
    expect(replayEarn.transaction.id).toBe(firstEarn.transaction.id);

    const awarded = await repos.communityPointAwardDecisions.updateOutcome(
      firstDecision.decision.id,
      {
        status: 'awarded',
        awardedTransactionId: firstEarn.transaction.id,
        evaluatedAt: new Date(),
      },
    );
    expect(awarded?.awardedTransactionId).toBe(firstEarn.transaction.id);
    expect(
      (await repos.communityPointTransactions.findByAwardDecision(firstDecision.decision.id))?.id,
    ).toBe(firstEarn.transaction.id);

    const projectedEarn = await repos.communityPointAccounts.incrementBalance(
      account!.id,
      rule!.points,
    );
    expect(projectedEarn?.pointsBalance).toBe(rule!.points);

    const reverse = await repos.communityPointTransactions.createIdempotent({
      accountId: account!.id,
      customerId,
      type: 'reverse',
      points: -rule!.points,
      sourceType: 'reversal',
      sourceRef: firstEarn.transaction.id,
      ruleId: rule!.id,
      awardDecisionId: firstDecision.decision.id,
      reversalOf: firstEarn.transaction.id,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(reverse.inserted).toBe(true);
    expect(
      (await repos.communityPointTransactions.findReversalOf(firstEarn.transaction.id))?.id,
    ).toBe(reverse.transaction.id);

    await expectUniqueViolation(
      repos.communityPointTransactions.createIdempotent({
        accountId: account!.id,
        customerId,
        type: 'reverse',
        points: -rule!.points,
        sourceType: 'reversal',
        sourceRef: firstEarn.transaction.id,
        ruleId: rule!.id,
        awardDecisionId: firstDecision.decision.id,
        reversalOf: firstEarn.transaction.id,
        idempotencyKey: crypto.randomUUID(),
      }),
    );

    const negative = await repos.communityPointAccounts.incrementBalance(
      account!.id,
      -(rule!.points * 2),
    );
    expect(negative?.pointsBalance).toBe(-rule!.points);

    const history = await repos.communityPointTransactions.listForAccount(account!.id);
    expect(history.map((row) => row.id)).toEqual(
      expect.arrayContaining([firstEarn.transaction.id, reverse.transaction.id]),
    );
  });
});
