import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';

/**
 * Verifies S4 roadmap Block 9's stale-pending sweep against a real
 * database, for two things a fake-repository unit test structurally cannot
 * check:
 *
 *  1. That `ai_usage_log_status_check` actually admits 'abandoned' -- i.e.
 *     that migration 0018 has been applied. A fake has no constraints at
 *     all, so it would happily "accept" a status the real column rejects.
 *     This is the same reasoning as qr-code-active-uniqueness's own
 *     integration test, and it is not hypothetical here: Block 7 shipped a
 *     schema change whose migration was never generated, and every summary
 *     rollup failed against exactly this constraint until 0017 landed.
 *  2. That the UPDATE's `WHERE status = 'pending' AND created_at < cutoff`
 *     really is what scopes the sweep -- that it moves stale pending rows
 *     and leaves fresh ones, and already-terminal ones, untouched.
 */
describe.skipIf(!process.env.DATABASE_URL)('ai_usage_log stale-pending sweep (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let businessId: string;

  const PERIOD_START = new Date('2026-07-01T00:00:00.000Z');
  const PERIOD_END = new Date('2026-07-08T00:00:00.000Z');
  const HOUR_MS = 60 * 60 * 1000;

  /** Every row this suite writes shares these; only status/createdAt vary. */
  function baseRow() {
    return {
      businessId,
      branchId: null,
      callSite: 'summary_generation',
      model: 'test-model',
      promptVersion: 'test-v1',
      periodType: 'weekly',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      inputTokens: null,
      outputTokens: null,
      costEstimateUsd: null,
    };
  }

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));

    const business = await repos.businesses.create({
      name: 'Stale Pending Sweep Test Business',
      slug: `stale-pending-test-${crypto.randomUUID()}`,
    });
    businessId = business.id;
  });

  afterAll(async () => {
    // Soft-delete only, matching every other suite here. ai_usage_log rows
    // cascade on business delete at the schema level, but nothing
    // hard-deletes the business itself -- point DATABASE_URL at a
    // scratch/dev database only.
    await repos.businesses.softDelete(businessId, businessId);
    await client.end();
  });

  it("accepts 'abandoned' as a status -- proves migration 0018 is applied", async () => {
    const row = await repos.aiUsageLog.record({ ...baseRow(), status: 'abandoned' });
    expect(row.status).toBe('abandoned');
  });

  it('moves a pending row older than the cutoff to abandoned, and stamps resolvedAt', async () => {
    const stale = await repos.aiUsageLog.record({
      ...baseRow(),
      status: 'pending',
      createdAt: new Date(Date.now() - 2 * HOUR_MS),
    });
    expect(stale.resolvedAt).toBeNull();

    const moved = await repos.aiUsageLog.abandonStalePending(new Date(Date.now() - HOUR_MS));
    expect(moved).toBeGreaterThanOrEqual(1);

    const after = await client.query('SELECT status, resolved_at FROM ai_usage_log WHERE id = $1', [
      stale.id,
    ]);
    expect(after.rows[0].status).toBe('abandoned');
    // resolvedAt records when the sweep noticed, not when the work stopped
    // (unknowable) -- createdAt still holds when the attempt began, so the
    // gap between the two stays legible.
    expect(after.rows[0].resolved_at).not.toBeNull();
  });

  it('leaves a pending row NEWER than the cutoff alone -- it may still be in flight', async () => {
    const fresh = await repos.aiUsageLog.record({ ...baseRow(), status: 'pending' });

    await repos.aiUsageLog.abandonStalePending(new Date(Date.now() - HOUR_MS));

    const after = await client.query('SELECT status FROM ai_usage_log WHERE id = $1', [fresh.id]);
    expect(after.rows[0].status).toBe('pending');
  });

  it('never overwrites a row that already reached a terminal state, however old it is', async () => {
    const old = new Date(Date.now() - 2 * HOUR_MS);
    const succeeded = await repos.aiUsageLog.record({
      ...baseRow(),
      status: 'success',
      inputTokens: 100,
      outputTokens: 50,
      costEstimateUsd: 0.42,
      createdAt: old,
    });
    const failed = await repos.aiUsageLog.record({ ...baseRow(), status: 'failed', createdAt: old });
    const blocked = await repos.aiUsageLog.record({ ...baseRow(), status: 'blocked', createdAt: old });

    await repos.aiUsageLog.abandonStalePending(new Date(Date.now() - HOUR_MS));

    const after = await client.query(
      'SELECT id, status, cost_estimate_usd FROM ai_usage_log WHERE id = ANY($1)',
      [[succeeded.id, failed.id, blocked.id]],
    );
    // Annotated rather than relying on pg's default `rows: any[]` -- this is
    // the first test here to map over a raw query result, so there is no
    // established precedent to inherit, and an explicit shape keeps this
    // readable besides.
    const rows = after.rows as Array<{ id: string; status: string; cost_estimate_usd: string | null }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[succeeded.id].status).toBe('success');
    expect(byId[failed.id].status).toBe('failed');
    expect(byId[blocked.id].status).toBe('blocked');
    // The success row's recorded cost must survive the sweep untouched --
    // clobbering it would corrupt the spend ledger the limit reads from.
    expect(Number(byId[succeeded.id].cost_estimate_usd)).toBeCloseTo(0.42);
  });

  it('returns 0 when there is nothing stale to sweep, rather than throwing', async () => {
    // A cutoff far enough in the past that no row this suite created can
    // possibly precede it.
    const moved = await repos.aiUsageLog.abandonStalePending(new Date('2000-01-01T00:00:00.000Z'));
    expect(moved).toBe(0);
  });

  it('excludes abandoned rows from the spend total -- an unknown cost is never counted as spend', async () => {
    const since = new Date(Date.now() - 24 * HOUR_MS);
    const before = await repos.aiUsageLog.totalCostSince(since);

    await repos.aiUsageLog.record({ ...baseRow(), status: 'abandoned' });

    // Unchanged: totalCostSince filters on status = 'success'. This is the
    // documented, accepted undercount -- an abandoned attempt that really
    // did reach Anthropic contributes nothing, because inventing a cost for
    // it would put a fabricated number into the ledger the spend limit
    // treats as fact. See ai-usage-log.ts's 'abandoned' note.
    expect(await repos.aiUsageLog.totalCostSince(since)).toBeCloseTo(before);
  });
});
