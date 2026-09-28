import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { FeedbackService } from '../../src/feedback/feedback.service';

describe.skipIf(!process.env.DATABASE_URL)('anonymous feedback idempotency (integration)', () => {
  let client: Client;
  let secondClient: Client;
  let db: ReturnType<typeof buildDb>;
  let secondDb: ReturnType<typeof buildDb>;
  let repos: ReturnType<typeof createRepositories>;
  let businessId: string;
  let qrCode: Awaited<ReturnType<ReturnType<typeof createRepositories>['qrCodes']['create']>>;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    secondClient = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([client.connect(), secondClient.connect()]);
    db = buildDb(client);
    secondDb = buildDb(secondClient);
    repos = createRepositories(db);
    const business = await repos.businesses.create({
      name: 'Feedback Idempotency Test',
      slug: `feedback-idempotency-${crypto.randomUUID()}`,
    });
    businessId = business.id;
    const branch = await repos.branches.create({
      businessId,
      name: 'Main',
      slug: `feedback-idempotency-branch-${crypto.randomUUID()}`,
    });
    qrCode = await repos.qrCodes.create({ businessId, branchId: branch.id });
  });

  afterAll(async () => {
    await repos.businesses.softDelete(businessId, businessId);
    await Promise.all([client.end(), secondClient.end()]);
  });

  it('allows only one row and one critical incident when identical requests race', async () => {
    const submissionKey = crypto.randomUUID();
    const input = { submissionKey, rating: 1, comment: 'There is a fire in the kitchen!' };
    const submit = (database: typeof db) =>
      database.transaction((tx) =>
        new FeedbackService(createRepositories(tx)).submitIdempotent(qrCode, input, {
          payloadHash: 'identical-request',
        }),
      );

    const [first, second] = await Promise.all([submit(db), submit(secondDb)]);
    expect([first.inserted, second.inserted].sort()).toEqual([false, true]);
    expect(first.feedback.id).toBe(second.feedback.id);

    const feedbackCount = await client.query(
      'SELECT count(*)::int AS n FROM feedback WHERE submission_key = $1',
      [submissionKey],
    );
    const incidentCount = await client.query(
      'SELECT count(*)::int AS n FROM critical_incidents WHERE feedback_id = $1',
      [first.feedback.id],
    );
    expect(feedbackCount.rows[0].n).toBe(1);
    expect(incidentCount.rows[0].n).toBe(1);
  });

  it('rejects a key reused with different content', async () => {
    const submissionKey = crypto.randomUUID();
    await db.transaction((tx) =>
      new FeedbackService(createRepositories(tx)).submitIdempotent(
        qrCode,
        { submissionKey, rating: 5 },
        { payloadHash: 'original' },
      ),
    );

    await expect(
      db.transaction((tx) =>
        new FeedbackService(createRepositories(tx)).submitIdempotent(
          qrCode,
          { submissionKey, rating: 1 },
          { payloadHash: 'changed' },
        ),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });
});

