import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';

describe.skipIf(!process.env.DATABASE_URL)('versioned feedback forms (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let businessId: string;
  let qrCodeId: string;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));
    const business = await repos.businesses.create({ name: 'Form Lifecycle Test', slug: `form-life-${crypto.randomUUID()}` });
    businessId = business.id;
    const branch = await repos.branches.create({ businessId, name: 'Main', slug: `form-life-branch-${crypto.randomUUID()}` });
    qrCodeId = (await repos.qrCodes.create({ businessId, branchId: branch.id })).id;
  });

  afterAll(async () => {
    await repos.businesses.softDelete(businessId, businessId);
    await client.end();
  });

  it('publishes, assigns, versions, and preserves normalized historical answers', async () => {
    const first = await repos.feedbackForms.createPublished(businessId, crypto.randomUUID(), {
      name: 'Visit', questions: [{ key: 'service', label: 'How was service?', type: 'text', required: true }],
    });
    await repos.feedbackForms.assign(qrCodeId, businessId, first.versionId);
    expect((await repos.feedbackForms.findForQr(qrCodeId))?.versionId).toBe(first.versionId);

    const feedback = await repos.feedback.create({
      businessId, branchId: (await repos.qrCodes.findById(qrCodeId, businessId))!.branchId,
      qrCodeId, formVersionId: first.versionId, rating: 5,
    });
    await repos.feedbackForms.createAnswers(feedback.id, first, [{ questionId: first.questions[0]!.id, value: 'Excellent' }]);

    const second = await repos.feedbackForms.createVersion(businessId, first.formId, {
      name: 'Visit', questions: [{ key: 'service', label: 'Tell us about service', type: 'textarea', required: true }],
    });
    await repos.feedbackForms.assign(qrCodeId, businessId, second.versionId);
    expect(second.version).toBe(2);
    expect((await repos.feedbackForms.findForQr(qrCodeId))?.versionId).toBe(second.versionId);

    const answer = await client.query('select question_key, question_label, question_type, value from feedback_answers where feedback_id = $1', [feedback.id]);
    expect(answer.rows[0]).toMatchObject({ question_key: 'service', question_label: 'How was service?', question_type: 'text', value: 'Excellent' });
  });
});

