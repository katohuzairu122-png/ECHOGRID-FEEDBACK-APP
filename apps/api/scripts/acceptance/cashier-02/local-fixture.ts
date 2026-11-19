import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { buildDb } from '../../../src/db/client';
import { createRepositories } from '../../../src/repositories';
import { RoleProvisioningService } from '../../../src/rbac/role-provisioning.service';
import { signCustomerAccessToken } from '../../../src/customer-auth/customer-jwt';

/**
 * CASHIER-AUTH-02E E2-C: builds a DISPOSABLE LOCAL fixture for the browser tier (a local API on 127.0.0.1:8787 and a local PostgreSQL).
 *
 * It is local-only by construction: it refuses any database that is not on loopback and named `echogrid*`, and it talks only to the fixed local API.
 * The owner is created through the REAL sign-up route and signs in through the real sign-in; business, branches and the cashier accounts are
 * created through real routes where they exist. Customers are the one exception: the real customer sign-up needs the web Worker and an email
 * link, so LOCAL customers are database fixtures with a locally minted session. Browser results that use them are labelled "local" and are
 * never accepted as staging evidence. The output file holds throw-away local credentials: keep it outside the repository.
 */
const LOCAL_API = 'http://localhost:8787/api/v1';

async function api(method: string, route: string, opts: { token?: string; businessId?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${LOCAL_API}${route}`, {
    method,
    headers: {
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.businessId ? { 'x-business-id': opts.businessId } : {}),
      ...(opts.headers ?? {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: any; error?: { code?: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, data: json.data, code: json.error?.code };
}

function devVar(name: string): string {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../.dev.vars');
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is not set in apps/api/.dev.vars`);
  return line.slice(name.length + 1).trim();
}

export interface LocalFixture {
  mode: 'local';
  apiBase: string;
  webBase: string;
  businessId: string;
  businessName: string;
  branches: Array<{ id: string; name: string }>;
  ownerEmail: string;
  ownerPassword: string;
  cashierCode: string;
  multi: { username: string; password: string };
  single: { username: string; password: string };
  customers: Array<{ id: string; token: string }>;
}

export async function buildLocalFixture(databaseUrl: string): Promise<LocalFixture> {
  const url = new URL(databaseUrl);
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.slice(1).startsWith('echogrid')) {
    throw new Error('the local fixture needs a loopback database named echogrid*');
  }
  const health = await fetch('http://localhost:8787/health').then((r) => r.json()).catch(() => null) as { environment?: string } | null;
  if (!health || health.environment !== 'development') throw new Error('the local API is not running in development mode on 127.0.0.1:8787');

  const run = randomUUID().slice(0, 8);
  const ownerEmail = `fx-owner-${run}@example.test`;
  const ownerPassword = `Fx-${randomBytes(9).toString('base64url')}-1`;
  const signup = await api('POST', '/auth/signup', { body: { email: ownerEmail, password: ownerPassword, fullName: 'Fixture Owner', businessName: 'Fixture' } });
  if (signup.status !== 201) throw new Error(`owner sign-up failed (${signup.status})`);
  const ownerId = JSON.parse(Buffer.from((signup.data.accessToken as string).split('.')[1] as string, 'base64url').toString()).sub as string;

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const repos = createRepositories(buildDb(client));
    const business = await repos.businesses.create({ name: `Alpha ${run}`, slug: `fx-${run}` });
    const branches: Array<{ id: string; name: string }> = [];
    for (const name of ['Alpha Main', 'Alpha Harbour', 'Alpha Third']) {
      const b = await repos.branches.create({ businessId: business.id, name, slug: name.toLowerCase().replace(/\s+/g, '-') });
      branches.push({ id: b.id, name });
    }
    const roles = await new RoleProvisioningService(repos).seedDefaultRoles(business.id, ownerId);
    await repos.userBusinessRoles.grant({ userId: ownerId, businessId: business.id, branchId: null, roleId: roles.Owner, createdBy: ownerId });

    const login = await api('POST', '/auth/login', { body: { email: ownerEmail, password: ownerPassword } });
    if (login.status !== 200) throw new Error(`owner sign-in failed (${login.status})`);
    const reauth = await api('POST', '/cashier-accounts/reauth', { token: login.data.accessToken, businessId: business.id, body: { password: ownerPassword } });
    if (reauth.status !== 200) throw new Error(`re-authentication failed (${reauth.status})`);
    const make = async (label: string, branchIds: string[]) => {
      const username = `fx${label}${run}`.toLowerCase().replace(/[^a-z0-9]/g, '');
      const password = `Fx-${randomBytes(9).toString('base64url')}-2`;
      const r = await api('POST', '/cashier-accounts', {
        token: login.data.accessToken, businessId: business.id, headers: { 'x-reauth-proof': reauth.data.proof },
        body: { username, displayName: `Fixture ${label}`, accessMode: branchIds.length > 1 ? 'multiple' : 'single', branchIds, password },
      });
      if (r.status !== 201) throw new Error(`cashier creation failed (${r.status} ${r.code ?? ''})`);
      return { username, password, code: r.data.cashierCode as string };
    };
    const multi = await make('m', [branches[0]!.id, branches[1]!.id, branches[2]!.id]);
    const single = await make('s', [branches[0]!.id]);

    const secret = devVar('CUSTOMER_JWT_SECRET');
    const customers: LocalFixture['customers'] = [];
    for (let i = 0; i < 3; i++) {
      const c = await repos.customers.create({ phone: `+1559${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}${i}${i}` });
      customers.push({ id: c.id, token: await signCustomerAccessToken(c.id, secret) });
    }
    return {
      mode: 'local', apiBase: 'http://localhost:8787', webBase: 'http://localhost:3000', businessId: business.id, businessName: business.name, branches,
      ownerEmail, ownerPassword, cashierCode: multi.code, multi: { username: multi.username, password: multi.password }, single: { username: single.username, password: single.password }, customers,
    };
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = process.argv[process.argv.indexOf('--out') + 1];
  if (!out || !process.argv.includes('--out')) throw new Error('usage: local-fixture.ts --out <file outside the repository>');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  buildLocalFixture(databaseUrl).then((f) => { writeFileSync(out, JSON.stringify(f, null, 2), { mode: 0o600 }); process.stdout.write(`local fixture written (${f.branches.length} branches, ${f.customers.length} customers)\n`); }, (e: unknown) => { process.stderr.write(`${e instanceof Error ? e.message : 'failed'}\n`); process.exitCode = 1; });
}
