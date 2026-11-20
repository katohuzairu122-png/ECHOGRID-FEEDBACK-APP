import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Bindings } from '../../src/config/env';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { errorHandler } from '../../src/lib/error-handler';
import { publicBusinessDirectoryRoutes } from '../../src/public/business-directory.routes';

/**
 * LANDING-ROLE-01: the anonymous business list for the customer sign-up page, through the REAL route and PostgreSQL. With
 * APP_RUNTIME_DATABASE_URL set the route runs as the restricted runtime login (it needs SELECT on businesses and qr_codes only).
 */
const databaseUrl = process.env.DATABASE_URL;
const app = new Hono<{ Bindings: Bindings }>();
app.route('/api/v1/public/businesses', publicBusinessDirectoryRoutes);
app.onError(errorHandler);

async function get(query = '', limited = false): Promise<{ status: number; body: { data?: { businesses: { name: string }[] }; error?: { code: string } }; cache: string | null }> {
  const pending: Promise<unknown>[] = [];
  const env = {
    HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl },
    PUBLIC_RATE_LIMITER: { limit: async () => ({ success: !limited }) },
  } as unknown as Bindings;
  const res = await app.request(`/api/v1/public/businesses${query}`, {}, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => undefined } as never);
  await Promise.allSettled(pending);
  return { status: res.status, body: (await res.json()) as never, cache: res.headers.get('cache-control') };
}

describe.skipIf(!databaseUrl)('public business directory (integration)', () => {
  let admin: Client;
  let repos: ReturnType<typeof createRepositories>;
  const tag = randomUUID().slice(0, 8);
  const names = {
    listed: `Dir ${tag} Listed Cafe`,
    listed2: `Dir ${tag} Another Bakery`,
    noQr: `Dir ${tag} No QR Shop`,
    revoked: `Dir ${tag} Revoked QR`,
    suspended: `Dir ${tag} Suspended Gym`,
    deleted: `Dir ${tag} Deleted Spa`,
    percent: `Dir ${tag} 100% Fresh`,
  };
  const ids: Record<string, string> = {};

  async function mk(key: keyof typeof names, opts: { qr?: 'active' | 'revoked' | null; status?: string; deleted?: boolean } = {}) {
    const b = await repos.businesses.create({ name: names[key], slug: `dir-${tag}-${key}` });
    ids[key] = b.id;
    const branch = await repos.branches.create({ businessId: b.id, name: 'Main', slug: `dir-${tag}-${key}-b` });
    if (opts.qr !== null) {
      const qr = await repos.qrCodes.create({ businessId: b.id, branchId: branch.id });
      if (opts.qr === 'revoked') await admin.query(`UPDATE qr_codes SET status = 'revoked' WHERE id = $1`, [qr.id]);
    }
    if (opts.status) await admin.query(`UPDATE businesses SET status = $2 WHERE id = $1`, [b.id, opts.status]);
    if (opts.deleted) await admin.query(`UPDATE businesses SET is_deleted = true WHERE id = $1`, [b.id]);
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    repos = createRepositories(buildDb(admin));
    await mk('listed');
    await mk('listed2');
    await mk('noQr', { qr: null });
    await mk('revoked', { qr: 'revoked' });
    await mk('suspended', { status: 'suspended' });
    await mk('deleted', { deleted: true });
    await mk('percent');
  });

  afterAll(async () => {
    for (const id of Object.values(ids)) await admin.query(`UPDATE businesses SET is_deleted = true WHERE id = $1`, [id]);
    await admin.end();
  });

  it('lists only active, non-deleted businesses that have an active QR code, names only, sorted, with a short cache', async () => {
    const r = await get(`?q=${encodeURIComponent(`Dir ${tag}`)}`);
    expect(r.status).toBe(200);
    expect(r.cache).toContain('max-age=60');
    const listed = r.body.data!.businesses;
    expect(listed.map((b) => b.name)).toEqual([names.percent, names.listed2, names.listed]);
    for (const b of listed) expect(Object.keys(b)).toEqual(['name']);
    const text = JSON.stringify(r.body);
    for (const id of Object.values(ids)) expect(text).not.toContain(id);
    for (const hidden of [names.noQr, names.revoked, names.suspended, names.deleted]) expect(text).not.toContain(hidden);
  });

  it('search is case-insensitive and treats % and _ as literal characters', async () => {
    expect((await get(`?q=${encodeURIComponent(`dir ${tag} listed`)}`)).body.data!.businesses.map((b) => b.name)).toEqual([names.listed]);
    const literal = await get(`?q=${encodeURIComponent(`${tag} 100%`)}`);
    expect(literal.body.data!.businesses.map((b) => b.name)).toEqual([names.percent]);
    expect((await get(`?q=${encodeURIComponent('%')}`)).body.data!.businesses.every((b) => b.name.includes('%'))).toBe(true);
  });

  it('is rate limited by the public limiter and never exceeds 100 names', async () => {
    const limited = await get('', true);
    expect(limited.status).toBe(429);
    expect(limited.body.error?.code).toBe('RATE_LIMITED');
    expect((await get()).body.data!.businesses.length).toBeLessThanOrEqual(100);
  });
});
