import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { FeedbackService } from '../../src/feedback/feedback.service';

/**
 * Verifies that a feedback row and its critical_incidents row are written
 * atomically (audit P1-3).
 *
 * WHY THIS CANNOT BE A UNIT TEST
 * The property under test is a database transaction boundary. The fake
 * repositories in feedback.service.test.ts are JavaScript Maps -- they have
 * no notion of rollback, so a fake will happily show both writes "undone"
 * or neither, whichever the fake was written to do, and prove nothing about
 * what Postgres does. The rollback is the whole subject here.
 *
 * WHAT WAS BROKEN
 * The pair was not transaction-wrapped, and the comment justifying that
 * said the critical-escalation sweep re-scanned for P0_CRITICAL feedback
 * with no incident row, making a gap "self-healing, not silent data loss".
 * No such re-scan exists -- the only sweep reads critical_incidents rows
 * that are already present, so it can escalate an unacknowledged incident
 * and never notice a missing one. A crash between the two writes dropped a
 * credible safety emergency permanently, and the comment is what stopped
 * anyone checking.
 *
 * The transaction now lives in qr.routes.ts, around the submit() call, with
 * the service handed transaction-scoped repositories. These tests exercise
 * that same shape directly.
 */
describe.skipIf(!process.env.DATABASE_URL)('critical-incident write atomicity (integration)', () => {
  let client: Client;
  let db: ReturnType<typeof buildDb>;
  let repos: ReturnType<typeof createRepositories>;
  let businessId: string;
  let branchId: string;
  let qrCode: Awaited<ReturnType<ReturnType<typeof createRepositories>['qrCodes']['create']>>;

  /** Known-critical phrasing -- the same signal critical-detector.ts's own
   * tests use, so this suite fails loudly if the detector's keywords change
   * rather than silently testing the non-critical path. */
  const CRITICAL = 'There is a fire in the kitchen!';

  /** Unique per test, so "is this row gone?" is answerable by comment text
   * without depending on what else the suite has written. */
  const marker = () => `${CRITICAL} ref-${crypto.randomUUID()}`;

  async function countFeedbackByComment(comment: string): Promise<number> {
    const result = await client.query('SELECT count(*)::int AS n FROM feedback WHERE comment = $1', [
      comment,
    ]);
    return (result.rows[0] as { n: number }).n;
  }

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    db = buildDb(client);
    repos = createRepositories(db);

    const business = await repos.businesses.create({
      name: 'Critical Atomicity Test Business',
      slug: `critical-atomicity-${crypto.randomUUID()}`,
    });
    businessId = business.id;

    const branch = await repos.branches.create({
      businessId,
      name: 'Main',
      slug: `critical-atomicity-branch-${crypto.randomUUID()}`,
    });
    branchId = branch.id;

    qrCode = await repos.qrCodes.create({ businessId, branchId });
  });

  afterAll(async () => {
    await repos.businesses.softDelete(businessId, businessId);
    await client.end();
  });

  it('commits the feedback row and its incident row together', async () => {
    const comment = marker();

    const created = await db.transaction(async (tx) =>
      new FeedbackService(createRepositories(tx)).submit(qrCode, { rating: 1, comment }),
    );

    expect(created.urgency).toBe('P0_CRITICAL');

    // Read back through the repository (findByFeedbackId is singular here,
    // unlike fraudSignals' plural -- one incident per feedback row) AND by
    // raw count, because the two answer different questions: that the
    // application can find it, and that there is exactly one of it.
    const incident = await repos.criticalIncidents.findByFeedbackId(created.id, businessId);
    expect(incident?.feedbackId).toBe(created.id);
    expect(incident?.branchId).toBe(branchId);

    const result = await client.query(
      'SELECT count(*)::int AS n FROM critical_incidents WHERE feedback_id = $1',
      [created.id],
    );
    expect((result.rows[0] as { n: number }).n).toBe(1);
  });

  it('rolls the feedback row back when the incident write fails -- the defect this closes', async () => {
    // The faithful reproduction: the feedback INSERT succeeds, then the
    // incident INSERT throws. Before the transaction, the feedback row
    // stayed and the safety alert was gone for good, with nothing able to
    // detect it. Now the whole submission is rejected, and the customer's
    // client sees a failure it can retry -- which is the correct outcome
    // for a safety report: losing it loudly beats losing it silently.
    const comment = marker();

    await expect(
      db.transaction(async (tx) => {
        const txRepos = createRepositories(tx);
        return new FeedbackService({
          feedback: txRepos.feedback,
          criticalIncidents: {
            create: async () => {
              throw new Error('simulated critical_incidents failure');
            },
          } as unknown as ReturnType<typeof createRepositories>['criticalIncidents'],
        }).submit(qrCode, { rating: 1, comment });
      }),
    ).rejects.toThrow('simulated critical_incidents failure');

    // The point of the whole change.
    expect(await countFeedbackByComment(comment)).toBe(0);
  });

  it('rolls back a committed-looking submission if the caller throws afterwards', async () => {
    // Proves the boundary is the TRANSACTION and not the service's own
    // internals: submit() returned successfully here, and the row still
    // does not survive. That is what lets the route add work after submit()
    // inside the same transaction later without re-reasoning about this.
    const comment = marker();

    await expect(
      db.transaction(async (tx) => {
        await new FeedbackService(createRepositories(tx)).submit(qrCode, { rating: 1, comment });
        throw new Error('caller failed after submit');
      }),
    ).rejects.toThrow('caller failed after submit');

    expect(await countFeedbackByComment(comment)).toBe(0);
  });

  it('writes no incident for a non-critical submission, and still commits the feedback', async () => {
    // Guards the detector wiring from the other side: if every submission
    // started creating an incident, the tests above would still pass.
    const comment = `Slow service and cold food. ref-${crypto.randomUUID()}`;

    const created = await db.transaction(async (tx) =>
      new FeedbackService(createRepositories(tx)).submit(qrCode, { rating: 2, comment }),
    );

    expect(created.urgency).not.toBe('P0_CRITICAL');
    expect(await countFeedbackByComment(comment)).toBe(1);

    const result = await client.query(
      'SELECT count(*)::int AS n FROM critical_incidents WHERE feedback_id = $1',
      [created.id],
    );
    expect((result.rows[0] as { n: number }).n).toBe(0);
  });

  it('records which keywords matched, so a reviewer can see why it escalated', async () => {
    const comment = marker();

    const created = await db.transaction(async (tx) =>
      new FeedbackService(createRepositories(tx)).submit(qrCode, { rating: 1, comment }),
    );

    const result = await client.query(
      'SELECT matched_signals FROM critical_incidents WHERE feedback_id = $1',
      [created.id],
    );
    const [row] = result.rows as Array<{ matched_signals: string | null }>;
    expect(row?.matched_signals).toBeTruthy();
    expect(row!.matched_signals).toContain('fire');
  });
});
