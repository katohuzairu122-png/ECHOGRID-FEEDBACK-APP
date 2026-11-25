import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';

/** CUST-DEL-01: the request table and its database guard, on real PostgreSQL (and as the restricted runtime login when APP_RUNTIME_DATABASE_URL is set). */
const databaseUrl = process.env.DATABASE_URL;
const DAY = 86_400_000;

describe.skipIf(!databaseUrl)('customer deletion requests (integration)', () => {
  let admin: Client;
  let repos: ReturnType<typeof createRepositories>;
  let app: Client;
  const phone = () => `+1555${Math.floor(1e6 + Math.random() * 9e6)}${Math.floor(Math.random() * 90 + 10)}`;
  const mk = async () => (await repos.customers.create({ phone: phone() })).id;

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    // The repository runs as the restricted runtime login when one is supplied; the owner connection is only for DDL-level probes.
    app = new Client({ connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl });
    await app.connect();
    repos = createRepositories(buildDb(app));
  });
  afterAll(async () => { await app?.end(); await admin?.end(); });

  it('files a pending request scheduled exactly 30 days out; filing again returns the same one', async () => {
    const id = await mk();
    const now = new Date('2026-11-25T10:00:00Z');
    const first = await repos.customerDeletionRequests.fileOrGetPending(id, now);
    expect(first.created).toBe(true);
    expect(first.request.status).toBe('pending');
    expect(first.request.scheduledFor.getTime()).toBe(now.getTime() + 30 * DAY);
    const again = await repos.customerDeletionRequests.fileOrGetPending(id, new Date(now.getTime() + 5 * DAY));
    expect(again.created).toBe(false);
    expect(again.request.id).toBe(first.request.id);
    expect((await repos.customerDeletionRequests.findPending(id))?.id).toBe(first.request.id);
  });

  it('restore cancels it; the customer has nothing pending and may file again later', async () => {
    const id = await mk();
    const now = new Date();
    await repos.customerDeletionRequests.fileOrGetPending(id, now);
    const cancelled = await repos.customerDeletionRequests.cancelPending(id, now);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.cancelledAt).not.toBeNull();
    expect(await repos.customerDeletionRequests.findPending(id)).toBeNull();
    expect(await repos.customerDeletionRequests.cancelPending(id, now)).toBeNull();
    expect((await repos.customerDeletionRequests.fileOrGetPending(id, now)).created).toBe(true);
  });

  it('one pending request per customer is enforced by the database, and requests of different customers are independent', async () => {
    const a = await mk(); const b = await mk();
    await repos.customerDeletionRequests.fileOrGetPending(a, new Date());
    expect(await repos.customerDeletionRequests.findPending(b)).toBeNull();
    await expect(admin.query(
      `insert into customer_deletion_requests (customer_id, requested_at, scheduled_for) values ($1, now(), now() + interval '30 days')`, [a],
    )).rejects.toThrow(/one_pending/);
  });

  it('the database refuses a window that is not 30 days and an inconsistent cancel shape', async () => {
    const id = await mk();
    await expect(admin.query(
      `insert into customer_deletion_requests (customer_id, requested_at, scheduled_for) values ($1, now(), now() + interval '1 day')`, [id],
    )).rejects.toThrow(/window_check/);
    await expect(admin.query(
      `insert into customer_deletion_requests (customer_id, status, requested_at, scheduled_for) values ($1, 'cancelled', now(), now() + interval '30 days')`, [id],
    )).rejects.toThrow(/cancel_shape/);
  });

  it('the guard: only pending -> cancelled; shortening the window, re-opening, DELETE and TRUNCATE are all refused, even for the owner', async () => {
    const id = await mk();
    const { request } = await repos.customerDeletionRequests.fileOrGetPending(id, new Date());
    await expect(admin.query(`update customer_deletion_requests set scheduled_for = requested_at + interval '30 days', requested_at = requested_at - interval '1 day' where id = $1`, [request.id])).rejects.toThrow();
    await expect(admin.query(`update customer_deletion_requests set status = 'processed' where id = $1`, [request.id])).rejects.toThrow(/IMMUTABLE/);
    await expect(admin.query(`delete from customer_deletion_requests where id = $1`, [request.id])).rejects.toThrow(/IMMUTABLE/);
    await expect(admin.query(`truncate customer_deletion_requests`)).rejects.toThrow(/IMMUTABLE/);
    await repos.customerDeletionRequests.cancelPending(id, new Date());
    await expect(admin.query(`update customer_deletion_requests set status = 'pending', cancelled_at = null where id = $1`, [request.id])).rejects.toThrow(/IMMUTABLE/);
  });

  it('the customer row cannot be hard-deleted while a request references it (RESTRICT)', async () => {
    const id = await mk();
    await repos.customerDeletionRequests.fileOrGetPending(id, new Date());
    await expect(admin.query(`delete from customers where id = $1`, [id])).rejects.toThrow();
  });

  it('only the pseudonymous id and timestamps are stored', async () => {
    const { rows } = await admin.query(`select column_name from information_schema.columns where table_name = 'customer_deletion_requests' order by 1`);
    expect(rows.map((r) => r.column_name)).toEqual(['cancelled_at', 'customer_id', 'id', 'requested_at', 'scheduled_for', 'status']);
  });
});
