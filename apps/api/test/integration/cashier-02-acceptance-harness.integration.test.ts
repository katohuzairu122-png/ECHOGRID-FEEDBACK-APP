import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { sign } from 'hono/jwt';
import type { Bindings } from '../../src/config/env';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { RoleProvisioningService } from '../../src/rbac/role-provisioning.service';
import { errorHandler } from '../../src/lib/error-handler';
import { auditTrail } from '../../src/middleware/audit';
import { cashierScopeGuard } from '../../src/middleware/cashier-scope';
import { authRoutes } from '../../src/auth/auth.routes';
import { branchRoutes } from '../../src/branches/branch.routes';
import { cashierAccountRoutes } from '../../src/cashier-accounts/cashier-accounts.routes';
import { cashierSessionRoutes } from '../../src/cashier-sessions/cashier-sessions.routes';
import { customerMembershipRoutes } from '../../src/customer-relationships/customer-membership.routes';
import { loyaltyRoutes } from '../../src/loyalty/loyalty.routes';
import { loyaltyCustomerRoutes } from '../../src/loyalty/loyalty-customer.routes';
import { analyticsRoutes } from '../../src/analytics/analytics.routes';
import { signCustomerAccessToken } from '../../src/customer-auth/customer-jwt';
import { pbkdf2Hash, pbkdf2Verify } from '../../src/auth/password';
import { createInProcessClient, type ApiResult, type CallOptions } from '../../scripts/acceptance/cashier-02/client';
import { runAcceptance } from '../../scripts/acceptance/cashier-02/runner';
import type { Context, CustomerProvisioner } from '../../scripts/acceptance/cashier-02/scenarios';
import { LiveCustomerProvisioner, type SignupDriver } from '../../scripts/acceptance/cashier-02/provisioner';
import { RestrictedVerificationMailbox } from '../../scripts/acceptance/cashier-02/verification-mailbox';
import { createLocalSpoolSource, SPOOL_ENV } from '../../scripts/acceptance/cashier-02/adapters/local-spool';
import { deliverToSpool } from '../../scripts/acceptance/cashier-02/adapters/local-spool-writer';
import { DELIVERY_KEY_ENV } from '../../scripts/acceptance/cashier-02/adapters/spool-envelope';
import { chmod, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseTargetsConfig } from '../../scripts/acceptance/cashier-02/guard';
import { buildRegistrationProofLink } from '../../src/customer-auth/customer-email-auth.delivery';
import stagingTargets from '../../scripts/acceptance/cashier-02/staging-targets.json';

/**
 * CASHIER-AUTH-02E E1: the acceptance scenarios, run against the REAL application (real middleware, routes, services) and a real local
 * PostgreSQL through an in-process client. This proves the scenarios are correct and discriminating; it is not a staging run. Live
 * execution stays disabled until the owner approves the staging hostnames.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('The harness integration test needs a loopback PostgreSQL database.');
}

const SECRET = 'harness-access-secret';
const CUSTOMER_SECRET = 'harness-customer-secret';
const run = randomUUID();
const allow = { limit: async () => ({ success: true }) };
const hasherNamespace = {
  newUniqueId: () => ({}),
  get: () => ({
    fetch: async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { action: string; input: string; storedHash?: string };
      const result = body.action === 'hash' ? await pbkdf2Hash(body.input, 1000) : await pbkdf2Verify(body.input, body.storedHash ?? '');
      return Response.json({ result });
    },
  }),
};

const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/v1/*', auditTrail, cashierScopeGuard);
app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/branches', branchRoutes);
app.route('/api/v1/cashier-accounts', cashierAccountRoutes);
app.route('/api/v1/cashier-sessions', cashierSessionRoutes);
app.route('/api/v1/customer-memberships', customerMembershipRoutes);
app.route('/api/v1/loyalty/me', loyaltyCustomerRoutes);
app.route('/api/v1/loyalty', loyaltyRoutes);
app.route('/api/v1/analytics', analyticsRoutes);
app.onError(errorHandler);

async function handle(method: string, path: string, call: CallOptions): Promise<ApiResult> {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers(call.headers);
  if (call.token) headers.set('Authorization', `Bearer ${call.token}`);
  if (call.businessId) headers.set('X-Business-Id', call.businessId);
  if (call.branchId) headers.set('X-Branch-Id', call.branchId);
  if (call.body !== undefined) headers.set('Content-Type', 'application/json');
  const env = {
    HYPERDRIVE: { connectionString: databaseUrl }, JWT_ACCESS_SECRET: SECRET, JWT_REFRESH_SECRET: 'harness-refresh-secret',
    CUSTOMER_JWT_SECRET: CUSTOMER_SECRET, QR_TOKEN_SECRET: 'harness-qr-secret', WEB_BASE_URL: 'https://web.example.test',
    PASSWORD_HASHER: hasherNamespace, AUTH_RATE_LIMITER: allow, API_RATE_LIMITER: allow, PUBLIC_RATE_LIMITER: allow,
    LOOKUP_RATE_LIMITER: allow, CUSTOMER_API_RATE_LIMITER: allow, JOBS: { send: async () => {}, sendBatch: async () => {} },
  } as unknown as Bindings;
  const response = await app.request(`/api/v1${path}`, {
    method, headers, ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  }, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await response.text();
  const json = (text ? JSON.parse(text) : {}) as { data?: unknown; error?: { code?: string; message?: string } };
  return { status: response.status, data: json.data, ...(json.error ? { error: json.error } : {}) };
}

describe.skipIf(!databaseUrl)('CASHIER-AUTH-02E E1 acceptance scenarios against the real application (local, in-process)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let ctx: Context;
  const PW = 'a-strong-owner-password-1';
  let phoneSeq = 0;

  const made = new Map<string, string>();
  const provisioner: CustomerProvisioner = {
    kind: 'local-fixture',
    canSetPhoneVerified: true,
    async create(label, opts) {
      const phone = `+1559${run.replace(/\D/g, '').padEnd(8, '3').slice(0, 5)}${String(++phoneSeq).padStart(2, '0')}`;
      const c = await repos.customers.create({ phone, ...(opts?.phoneVerified ? { phoneVerifiedAt: new Date() } : {}) });
      made.set(label, c.id);
      return { id: c.id, token: await signCustomerAccessToken(c.id, CUSTOMER_SECRET) };
    },
    async returning(label) {
      const id = made.get(label);
      if (!id) throw new Error('unknown customer');
      return { id, token: await signCustomerAccessToken(id, CUSTOMER_SECRET) };
    },
  };

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect();
    repos = createRepositories(buildDb(client));
    const mk = async (label: string) => (await repos.users.create({ email: `h-${label}-${run}@example.test`, fullName: label, passwordHash: await pbkdf2Hash(PW, 1000), status: 'active' }));
    const ownerA = await mk('a');
    const ownerB = await mk('b');
    const bizA = (await repos.businesses.create({ name: 'Harness A', slug: `h-a-${run}` })).id;
    const bizB = (await repos.businesses.create({ name: 'Harness B', slug: `h-b-${run}` })).id;
    for (const n of ['a1', 'a2', 'a3']) await repos.branches.create({ businessId: bizA, name: n, slug: n });
    await repos.branches.create({ businessId: bizB, name: 'b1', slug: 'b1' });
    const provisioning = new RoleProvisioningService(repos);
    const rolesA = await provisioning.seedDefaultRoles(bizA, ownerA.id);
    const rolesB = await provisioning.seedDefaultRoles(bizB, ownerB.id);
    await repos.userBusinessRoles.grant({ userId: ownerA.id, businessId: bizA, branchId: null, roleId: rolesA.Owner, createdBy: ownerA.id });
    await repos.userBusinessRoles.grant({ userId: ownerB.id, businessId: bizB, branchId: null, roleId: rolesB.Owner, createdBy: ownerB.id });
    ctx = {
      api: createInProcessClient(handle), runId: 'loc' + run.replace(/[^a-z0-9]/g, '').slice(0, 6), provisioner,
      ownerA: { email: ownerA.email as string, password: PW, businessId: bizA }, ownerB: { email: ownerB.email as string, password: PW, businessId: bizB },
      forgeInvite: (claims) => sign(claims, SECRET, 'HS256'),
    };
  });
  afterAll(async () => { await client?.end(); });

  it('every scenario runs, every check passes, nothing is skipped except the browser scenario (no browser report supplied)', async () => {
    const out = await runAcceptance({ ctx, mode: 'local', commit: 'abcdef0' });
    const failing = out.report.checks.filter((c) => c.status === 'FAIL');
    expect(failing, JSON.stringify(failing, null, 1)).toEqual([]);
    expect(out.report.state).toBe('COMPLETE');
    const notRun = out.report.checks.filter((c) => c.status === 'NOT_RUN').map((c) => c.id);
    expect(notRun).toEqual(['S14.1']);
    expect(out.report.counts.pass).toBeGreaterThanOrEqual(53);
    expect(new Set(out.report.checks.map((c) => c.scenario)).size).toBe(15);
  });

  it('the report is redacted: no token, password, email, phone, code or identifier appears in it', async () => {
    const out = await runAcceptance({ ctx: { ...ctx, runId: 'loc' + randomUUID().replace(/[^a-z0-9]/g, '').slice(0, 6) }, mode: 'local', commit: 'abcdef0', only: ['S03', 'S06'] });
    const text = JSON.stringify(out.report);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{5,}\./);
    expect(text).not.toMatch(/@example\.test|\+1559/);
    expect(text).not.toContain(PW);
  });

  it('without a customer provisioner the customer scenarios are NOT RUN (never passed) and the rest still run', async () => {
    const out = await runAcceptance({ ctx: { ...ctx, provisioner: null, runId: 'loc' + randomUUID().replace(/[^a-z0-9]/g, '').slice(0, 6) }, mode: 'local', commit: 'abcdef0' });
    expect(out.report.counts.fail).toBe(0);
    const byScenario = (id: string) => out.report.checks.filter((c) => c.scenario === id).map((c) => c.status);
    for (const id of ['S04', 'S05', 'S07', 'S10', 'S11', 'S12', 'S13', 'S15']) expect(byScenario(id), id).toEqual(['NOT_RUN']);
    for (const id of ['S01', 'S02', 'S09']) expect(byScenario(id).every((s) => s === 'PASS'), id).toBe(true);
    expect(byScenario('S08').filter((s) => s === 'FAIL')).toEqual([]);
    expect(out.report.checks.find((c) => c.id === 'S08.5')?.status).toBe('NOT_RUN');
  });

  it('MOCK-BACKED: scenarios that need customers run through the live provisioner abstraction with the authenticated local spool (a fixture delivery boundary and a fixture sign-up driver), not through the real web sign-up or a real mailbox', async () => {
    const config = parseTargetsConfig({
      ...stagingTargets, approved: true, approvedBy: 'owner', approvedAt: 'test',
      mailbox: { approved: true, approvedBy: 'owner', adapter: 'local-spool', allowedRecipientDomains: ['mail.example.test'] },
      customerProvisioning: { approved: true, approvedBy: 'owner' },
    });
    const runId = 'mock' + randomUUID().replace(/[^a-z0-9]/g, '').slice(0, 5);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'spool-'));
    await chmod(dir, 0o700);
    const env = { [SPOOL_ENV]: dir, [DELIVERY_KEY_ENV]: 'k'.repeat(40) };
    const mailbox = new RestrictedVerificationMailbox({ runId, config: config.mailbox, webHost: config.targets.web.host, source: createLocalSpoolSource(env), attempts: 1, sleep: async () => {} });
    const byEmail = new Map<string, string>();
    const driver: SignupDriver = {
      // the fixture delivery boundary: the real application would send the email; here the boundary places the application's own link format in the spool
      async requestSignup(email) { await deliverToSpool({ env, to: email, receivedAtMs: Date.now(), text: buildRegistrationProofLink(`https://${config.targets.web.host}`, '8142403d-073a-4ff9-9d4d-4f7a07b5c550', 'ab12'.repeat(16)) }); },
      async completeSignup() {},
      async signIn(email) {
        let id = byEmail.get(email);
        if (!id) { id = (await provisioner.create(`m${byEmail.size}`)).id; byEmail.set(email, id); }
        return { customerId: id, accessToken: await signCustomerAccessToken(id, CUSTOMER_SECRET) };
      },
    };
    const live = new LiveCustomerProvisioner({ runId, config, mailbox, driver });
    const out = await runAcceptance({ ctx: { ...ctx, provisioner: live, runId }, mode: 'local', commit: 'abcdef0', only: ['S04', 'S05', 'S15'] });
    expect(out.report.checks.filter((c) => c.status !== 'PASS'), JSON.stringify(out.report.checks.filter((c) => c.status !== 'PASS'))).toEqual([]);
    expect(out.report.counts.pass).toBeGreaterThanOrEqual(10);
    expect(JSON.stringify(out.report)).not.toMatch(/ab12ab12|loyalty\/signup\/verify|8142403d/);
    expect(mailbox.evidence().length).toBeGreaterThan(0);
    expect(mailbox.evidence().every((e) => e.cleanup === 'done')).toBe(true);
    expect(await (await import('node:fs/promises')).readdir(dir)).toEqual([]);
  });

  describe('the scenarios discriminate: a faulty application is caught, not passed', () => {
    const faulty = (tamper: (method: string, path: string, call: CallOptions, real: ApiResult) => ApiResult | null): Context => ({
      ...ctx,
      runId: 'bad' + randomUUID().replace(/[^a-z0-9]/g, '').slice(0, 6),
      api: createInProcessClient(async (method, path, call) => {
        const real = await handle(method, path, call);
        return tamper(method, path, call, real) ?? real;
      }),
    });
    const failed = async (c: Context, only: string[]) => (await runAcceptance({ ctx: c, mode: 'local', commit: 'abcdef0', only })).report.checks.filter((x) => x.status === 'FAIL').map((x) => x.id);

    it('an application that accepts a join without consent fails S04.1', async () => {
      const c = faulty((m, p, call, real) => (p === '/customer-memberships/join-assisted' && (call.body as { consentAccepted?: boolean }).consentAccepted === false ? { status: 201, data: {} } : real.status === 0 ? real : null));
      expect(await failed(c, ['S04'])).toContain('S04.1');
    });
    it('an application that lets an invitation be used twice fails S05.2', async () => {
      const c = faulty((m, p, _call, real) => (p === '/customer-memberships/join-assisted' && real.status === 409 ? { status: 201, data: {} } : null));
      expect(await failed(c, ['S05'])).toContain('S05.2');
    });
    it('an application that lets another business read this business\'s report fails S09.2', async () => {
      const c = faulty((m, p, call, real) => (p === '/analytics/onboarding' && call.businessId === ctx.ownerA.businessId && real.status === 403 ? { status: 200, data: { totals: {} } } : null));
      expect(await failed(c, ['S09'])).toContain('S09.2');
    });
    it('an application that silently skips session revocation fails S12.1', async () => {
      const c: Context = { ...ctx, runId: 'bad' + randomUUID().replace(/[^a-z0-9]/g, '').slice(0, 6), api: createInProcessClient(async (method, path, call) => (path.endsWith('/revoke-sessions') ? { status: 200, data: {} } : handle(method, path, call))) };
      expect(await failed(c, ['S12'])).toContain('S12.1');
    });
    it('an application that accepts a branch switch to an unassigned branch fails S08.1', async () => {
      const c = faulty((m, p, call, real) => (p === '/auth/cashier/switch-branch' && real.status === 403 ? { status: 200, data: { session: { branchId: (call.body as { branchId: string }).branchId } } } : null));
      expect(await failed(c, ['S08'])).toContain('S08.1');
    });
  });
});
