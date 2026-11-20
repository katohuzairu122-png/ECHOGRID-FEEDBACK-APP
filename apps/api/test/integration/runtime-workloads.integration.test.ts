import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { FeedbackService } from '../../src/feedback/feedback.service';
import worker from '../../src/index';

/**
 * R8-G-STAGING-01: background workloads under the restricted runtime login.
 *
 * Only the API Worker connects to PostgreSQL (through the HYPERDRIVE binding), and its queue consumer and cron handler open their own
 * connection from that binding. These tests call the REAL exported `queue` and `scheduled` handlers with a HYPERDRIVE binding that points at
 * APP_RUNTIME_DATABASE_URL (the restricted login; falls back to DATABASE_URL when unset), while fixtures use the admin connection. A privilege
 * gap would show as `permission denied`; `alertOnFailure`/`notifyOps` swallow cron errors by design, so every test also asserts that nothing was
 * reported through console.error and checks the database effect directly.
 */
const RUNTIME_URL = process.env.APP_RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!process.env.DATABASE_URL)('API Worker background workloads on the runtime login (integration)', () => {
  let admin: Client;
  let repos: ReturnType<typeof createRepositories>;
  let businessId: string;
  let branchId: string;
  let qrCode: Awaited<ReturnType<ReturnType<typeof createRepositories>['qrCodes']['create']>>;
  let errors: string[];

  const sent: unknown[] = [];
  const env = () =>
    ({
      HYPERDRIVE: { connectionString: RUNTIME_URL },
      ENVIRONMENT: 'development',
      JOBS: { send: async (m: unknown) => { sent.push(m); }, sendBatch: async (m: unknown[]) => { sent.push(...m); } },
      AI: { run: async () => { throw new Error('AI not used in this suite'); } },
      CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    }) as never;

  const ctx = () => {
    const pending: Promise<unknown>[] = [];
    return { ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => undefined } as never, settle: () => Promise.allSettled(pending) };
  };

  const message = (body: unknown) => {
    const m = { id: crypto.randomUUID(), attempts: 1, body, acked: false, retried: false, ack() { m.acked = true; }, retry() { m.retried = true; } };
    return m;
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    repos = createRepositories(buildDb(admin));
    businessId = (await repos.businesses.create({ name: 'Workload Test Business', slug: `workload-${crypto.randomUUID()}` })).id;
    branchId = (await repos.branches.create({ businessId, name: 'Main', slug: `workload-b-${crypto.randomUUID()}` })).id;
    qrCode = await repos.qrCodes.create({ businessId, branchId });
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await repos.businesses.softDelete(businessId, businessId);
    await admin.end();
  });

  it('classify_feedback: the consumer reads the feedback and persists its sentiment result', async () => {
    errors.length = 0;
    const fb = await buildDb(admin).transaction((tx) => new FeedbackService(createRepositories(tx)).submit(qrCode, { rating: 5 }));
    const m = message({ type: 'classify_feedback', feedbackId: fb.id, businessId });
    const { ctx: c, settle } = ctx();
    await worker.queue({ queue: 'echo-grid-feedback-jobs', messages: [m] } as never, env(), c);
    await settle();
    expect(m.acked, errors.join('|')).toBe(true);
    expect(m.retried).toBe(false);
    const row = (await admin.query('SELECT sentiment, analysis_status FROM feedback WHERE id = $1', [fb.id])).rows[0] as { sentiment: string | null; analysis_status: string };
    expect(row.analysis_status).not.toBe('pending');
    expect(row.sentiment).not.toBeNull();
    expect(errors).toEqual([]);
  });

  it('escalate_critical_incident: marks the incident escalated (read and update as the runtime)', async () => {
    errors.length = 0;
    const fb = await buildDb(admin).transaction((tx) => new FeedbackService(createRepositories(tx)).submit(qrCode, { rating: 1, comment: `There is a fire in the kitchen! ${crypto.randomUUID()}` }));
    const incident = await repos.criticalIncidents.findByFeedbackId(fb.id, businessId);
    expect(incident).toBeTruthy();
    const m = message({ type: 'escalate_critical_incident', incidentId: incident!.id, businessId });
    const { ctx: c, settle } = ctx();
    await worker.queue({ queue: 'echo-grid-feedback-jobs', messages: [m] } as never, env(), c);
    await settle();
    expect(m.acked, errors.join('|')).toBe(true);
    const row = (await admin.query('SELECT escalated_at FROM critical_incidents WHERE id = $1', [incident!.id])).rows[0] as { escalated_at: Date | null };
    expect(row.escalated_at).not.toBeNull();
    expect(errors).toEqual([]);
  });

  it('send_notification: delivery inserts the notification row and marks it sent', async () => {
    errors.length = 0;
    const address = `w-${crypto.randomUUID()}@example.test`;
    const userId = ((await admin.query(`INSERT INTO users (email, password_hash, full_name) VALUES ($1, 'x', 'Workload User') RETURNING id`, [address])).rows[0] as { id: string }).id;
    const m = message({ type: 'send_notification', businessId, userId, eventType: 'summary_ready', channel: 'email', recipientAddress: address, subject: 's', body: 'b' });
    const { ctx: c, settle } = ctx();
    await worker.queue({ queue: 'echo-grid-feedback-jobs', messages: [m] } as never, env(), c);
    await settle();
    expect(m.acked, errors.join('|')).toBe(true);
    const row = (await admin.query('SELECT status FROM notifications WHERE business_id = $1 AND recipient_address = $2', [businessId, address])).rows[0] as { status: string } | undefined;
    expect(row?.status).toBe('sent');
    expect(errors.filter((e) => /permission denied/i.test(e))).toEqual([]);
  });

  it('dead-letter consumer works without touching the database', async () => {
    const m = message({ type: 'unexpected_personal_data' });
    const { ctx: c, settle } = ctx();
    await worker.queue({ queue: 'echo-grid-feedback-jobs-dlq', messages: [m] } as never, { ...(env() as object), HYPERDRIVE: { connectionString: 'postgresql://nobody:x@127.0.0.1:1/none' } } as never, c);
    await settle();
    expect(errors.filter((e) => /permission denied/i.test(e))).toEqual([]);
  });

  it('5-minute cron: the escalation sweep enqueues the overdue incident, the stale-AI sweep abandons the stale row, and no sweep reports a failure', async () => {
    errors.length = 0;
    sent.length = 0;
    const fb = await buildDb(admin).transaction((tx) => new FeedbackService(createRepositories(tx)).submit(qrCode, { rating: 1, comment: `There is a fire in the kitchen! ${crypto.randomUUID()}` }));
    const incident = await repos.criticalIncidents.findByFeedbackId(fb.id, businessId);
    await admin.query(`UPDATE critical_incidents SET created_at = now() - interval '2 hours' WHERE id = $1`, [incident!.id]);
    const stale = (await admin.query(
      `INSERT INTO ai_usage_log (business_id, call_site, model, prompt_version, period_type, period_start, period_end, status, created_at)
       VALUES ($1, 'summary', 'm', 'v1', 'daily', now() - interval '2 days', now() - interval '1 day', 'pending', now() - interval '3 hours') RETURNING id`, [businessId])).rows[0] as { id: string };
    const { ctx: c, settle } = ctx();
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now(), type: 'scheduled', noRetry() {} } as never, env(), c);
    await settle();
    expect(JSON.stringify(sent)).toContain(incident!.id);
    expect(((await admin.query('SELECT status FROM ai_usage_log WHERE id = $1', [stale.id])).rows[0] as { status: string }).status).toBe('abandoned');
    expect(errors.filter((e) => /permission denied|sweep.*failed|heartbeat.*failed|expiry sweep/i.test(e)), errors.join(' | ')).toEqual([]);
  });

  it('daily cron: prunes old OTP rows (DELETE) and enqueues the per-business summary jobs', async () => {
    errors.length = 0;
    sent.length = 0;
    const old = (await admin.query(
      `INSERT INTO otp_codes (phone, code_hash, expires_at, created_at) VALUES ('+15550000001', 'h', now() - interval '30 days', now() - interval '30 days') RETURNING id`)).rows[0] as { id: string };
    const { ctx: c, settle } = ctx();
    await worker.scheduled({ cron: '0 0 * * *', scheduledTime: Date.now(), type: 'scheduled', noRetry() {} } as never, env(), c);
    await settle();
    expect((await admin.query('SELECT 1 FROM otp_codes WHERE id = $1', [old.id])).rowCount).toBe(0);
    expect(JSON.stringify(sent)).toContain(businessId);
    expect(errors.filter((e) => /permission denied|prune failed/i.test(e)), errors.join(' | ')).toEqual([]);
  });
});
