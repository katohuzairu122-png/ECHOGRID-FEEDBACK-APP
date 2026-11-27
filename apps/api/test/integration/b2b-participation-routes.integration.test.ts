import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Bindings } from '../../src/config/env';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { RoleProvisioningService } from '../../src/rbac/role-provisioning.service';
import { errorHandler } from '../../src/lib/error-handler';
import { b2bRoutes } from '../../src/b2b/b2b.routes';
import { platformB2bRoutes } from '../../src/platform/b2b.routes';
import { signAccessToken, signCashierAccessToken, signImpersonationToken } from '../../src/auth/jwt';
import { pbkdf2Hash } from '../../src/auth/password';
import { appDbOf } from '../helpers/runtime-db';

const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'b2b-participation-routes-secret';
const app = new Hono<{ Bindings: Bindings }>();
app.route('/api/v1/b2b', b2bRoutes);
app.route('/api/v1/platform/b2b', platformB2bRoutes);
app.onError(errorHandler);

type Call = { token?: string; businessId?: string; path?: string };
async function get(path: string, call: Call = {}) {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers();
  if (call.token) headers.set('Authorization', `Bearer ${call.token}`);
  if (call.businessId) headers.set('X-Business-Id', call.businessId);
  const env = {
    HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl },
    JWT_ACCESS_SECRET: SECRET,
    API_RATE_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as Bindings;
  const response = await app.request(`/api/v1${path}`, { headers }, env,
    { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() as { data?: unknown; error?: { code: string } } };
}

describe.skipIf(!databaseUrl)('B2B participation API (real HTTP, real PostgreSQL)', () => {
  let client: Client;
  const run = randomUUID().slice(0, 8);
  const ids = {} as { bizA: string; bizB: string; ownerA: string; outsider: string; branchManagerA: string; admin: string; support: string };
  const token: Record<string, string> = {};

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const repos = createRepositories(appDbOf(buildDb(client)));
    const user = async (label: string, platformRole?: 'admin' | 'support') => (await repos.users.create({
      email: `b2b-route-${label}-${run}@example.test`, fullName: label,
      passwordHash: await pbkdf2Hash('unused-password-1', 1000), status: 'active',
      ...(platformRole ? { platformRole } : {}),
    })).id;
    ids.admin = await user('admin', 'admin');
    ids.support = await user('support', 'support');
    ids.ownerA = await user('owner-a');
    ids.outsider = await user('outsider');
    ids.branchManagerA = await user('branch-manager-a');
    ids.bizA = (await repos.businesses.create({ name: 'B2B route A', slug: `b2b-route-a-${run}` })).id;
    ids.bizB = (await repos.businesses.create({ name: 'B2B route B', slug: `b2b-route-b-${run}` })).id;
    const branch = (await repos.branches.create({ businessId: ids.bizA, name: 'Branch', slug: `b2b-${run}` })).id;
    const provision = new RoleProvisioningService(repos);
    const rolesA = await provision.seedDefaultRoles(ids.bizA, ids.ownerA);
    await repos.userBusinessRoles.grant({ userId: ids.ownerA, businessId: ids.bizA, branchId: null, roleId: rolesA.Owner, createdBy: ids.ownerA });
    await repos.userBusinessRoles.grant({ userId: ids.branchManagerA, businessId: ids.bizA, branchId: branch, roleId: rolesA.Manager, createdBy: ids.ownerA });
    for (const [name, id] of Object.entries(ids)) token[name] = await signAccessToken(id, SECRET);
    token.cashier = await signCashierAccessToken(ids.ownerA, SECRET, { sessionId: randomUUID(), businessId: ids.bizA, branchId: branch });
    token.impersonated = (await signImpersonationToken(ids.ownerA, ids.admin, SECRET)).token;
  });

  afterAll(async () => { await client?.end(); });

  it('returns only the authenticated business participation state and disables caching', async () => {
    const res = await get('/b2b/participation', { token: token.ownerA!, businessId: ids.bizA });
    expect(res.status).toBe(200);
    expect(res.cache).toBe('no-store');
    expect(res.body.data).toEqual({ businessId: ids.bizA, status: 'not_enrolled', termsVersionId: null, enrolledAt: null, suspendedAt: null });
  });

  it('denies anonymous, foreign-tenant, and branch-scoped requests', async () => {
    expect((await get('/b2b/participation', { businessId: ids.bizA })).status).toBe(401);
    expect((await get('/b2b/participation', { token: token.outsider!, businessId: ids.bizA })).status).toBe(403);
    expect((await get('/b2b/participation', { token: token.branchManagerA!, businessId: ids.bizA })).status).toBe(403);
    expect((await get('/b2b/participation', { token: token.ownerA!, businessId: ids.bizB })).status).toBe(403);
    expect((await get('/b2b/participation', { token: token.cashier!, businessId: ids.bizA })).status).toBe(403);
  });

  it('exposes the bounded read-only participation queue to platform admins only', async () => {
    const allowed = await get('/platform/b2b/participations?limit=10&offset=0', { token: token.admin! });
    expect(allowed.status).toBe(200);
    expect(allowed.cache).toBe('no-store');
    expect(allowed.body.data).toMatchObject({ data: [], page: { limit: 10, offset: 0, hasMore: false } });
    expect((await get('/platform/b2b/participations', { token: token.support! })).status).toBe(403);
    expect((await get('/platform/b2b/participations', { token: token.ownerA! })).status).toBe(403);
    expect((await get('/platform/b2b/participations', { token: token.impersonated! })).status).toBe(403);
    expect((await get('/platform/b2b/participations?limit=101', { token: token.admin! })).status).toBe(400);
  });
});
