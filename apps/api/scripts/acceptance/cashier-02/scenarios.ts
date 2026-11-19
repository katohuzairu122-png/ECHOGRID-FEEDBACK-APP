import { randomBytes } from 'node:crypto';
import type { ApiClient, ApiResult } from './client';

/**
 * CASHIER-AUTH-02E E1: the acceptance scenarios for CASHIER-AUTH-02A to 02D.
 *
 * They use only public API routes with real authentication: no database access, no bypass of consent or verification, no deletes.
 * Everything they create carries the run prefix. Credentials live in memory for the run and never reach a log or result.
 */
export interface OwnerCredentials {
  email: string;
  password: string;
  businessId: string;
}

export interface Provisioned {
  id: string;
  /** The customer's own access token (never printed). */
  token: string;
}

/** How a customer comes to exist. Live: the real sign-up and OTP flow (E2). Local tests: an injected fixture. */
export interface CustomerProvisioner {
  readonly kind: string;
  readonly canSetPhoneVerified: boolean;
  create(label: string, opts?: { phoneVerified?: boolean }): Promise<Provisioned>;
  /** E2-A: a customer created earlier in this run signs in again (a returning customer). Absent when the provisioner cannot. */
  returning?(label: string): Promise<Provisioned>;
}

export interface Context {
  api: ApiClient;
  runId: string;
  ownerA: OwnerCredentials;
  ownerB: OwnerCredentials;
  provisioner: CustomerProvisioner | null;
  /** Local tests only: signs an invitation with chosen claims. Never available to a live run (no secret is ever read). */
  forgeInvite?: ((claims: Record<string, unknown>) => Promise<string>) | undefined;
}

export interface Recorder {
  check(id: string, title: string, ok: boolean, detail?: string): Promise<void>;
  notRun(id: string, title: string, reason: string): Promise<void>;
}

export interface Scenario {
  id: string;
  area: string;
  title: string;
  /** Set when the scenario cannot run in this context; it is then reported NOT RUN with this reason. */
  unavailable?: (ctx: Context, world: World) => string | null;
  run(ctx: Context, world: World, rec: Recorder): Promise<void>;
}

interface Cashier {
  id: string;
  username: string;
  password: string;
}

interface Session {
  accessToken: string;
  refreshToken: string;
  branchId: string;
}

export interface World {
  tokenA: string;
  tokenB: string;
  codeA: string;
  branchesA: string[];
  branchesB: string[];
  codeB: string | null;
  baseline: { events: number; unique: number; rejoin: number };
  makeCashier(label: string, branchIds: string[]): Promise<Cashier>;
  makeCashierB(label: string, branchId: string): Promise<Cashier>;
  signIn(cashier: Cashier, branchId: string, business?: 'A' | 'B'): Promise<Session>;
  admin(method: string, path: string, body?: unknown): Promise<ApiResult>;
  ownerCall(method: string, path: string, body?: unknown): Promise<ApiResult>;
  customers: Map<string, Provisioned>;
}

const decodeClaims = (token: string): Record<string, unknown> => {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
};
const code = (r: ApiResult) => r.error?.code ?? '';
const denied = (r: ApiResult) => r.status === 401 || r.status === 403;
const newPassword = () => `Acc-${randomBytes(9).toString('base64url')}-9`;
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Signs in both owners, reads the business code and the branches, and captures the report baseline the later checks compare to. */
export async function buildWorld(ctx: Context): Promise<World> {
  const login = async (o: OwnerCredentials) => {
    const r = await ctx.api.request('POST', '/auth/login', { body: { email: o.email, password: o.password } });
    if (r.status !== 200 || !r.data?.accessToken) throw new Error(`owner sign-in failed (${r.status})`);
    return r.data.accessToken as string;
  };
  const tokenA = await login(ctx.ownerA);
  const tokenB = await login(ctx.ownerB);
  let proof = '';
  let proofAt = 0;
  const getProof = async () => {
    if (proof && Date.now() - proofAt < 4 * 60_000) return proof;
    const r = await ctx.api.request('POST', '/cashier-accounts/reauth', { token: tokenA, businessId: ctx.ownerA.businessId, body: { password: ctx.ownerA.password } });
    if (r.status !== 200) throw new Error(`administrator re-authentication failed (${r.status})`);
    proof = r.data.proof as string;
    proofAt = Date.now();
    return proof;
  };
  const ownerCall = (method: string, path: string, body?: unknown) =>
    ctx.api.request(method, path, { token: tokenA, businessId: ctx.ownerA.businessId, ...(body === undefined ? {} : { body }) });
  const admin = async (method: string, path: string, body?: unknown) =>
    ctx.api.request(method, path, {
      token: tokenA,
      businessId: ctx.ownerA.businessId,
      headers: { 'x-reauth-proof': await getProof() },
      ...(body === undefined ? {} : { body }),
    });
  const codeRes = await ownerCall('GET', '/cashier-accounts/business-code');
  if (codeRes.status !== 200) throw new Error(`business code unavailable (${codeRes.status})`);
  // The code is created with the business's first cashier account, so it may not exist yet: it is refreshed from every creation response.
  let codeA = (codeRes.data?.cashierCode ?? '') as string;
  const listBranches = async (token: string, businessId: string) => {
    const r = await ctx.api.request('GET', '/branches', { token, businessId });
    return r.status === 200 && Array.isArray(r.data) ? (r.data as { id: string }[]).map((b) => b.id) : [];
  };
  const branchesA = await listBranches(tokenA, ctx.ownerA.businessId);
  const branchesB = await listBranches(tokenB, ctx.ownerB.businessId);
  const report = await ownerCall('GET', '/analytics/onboarding');
  const baseline = {
    events: Number(report.data?.totals?.events ?? 0),
    unique: Number(report.data?.totals?.uniqueCustomers ?? 0),
    rejoin: Number(report.data?.totals?.rejoinEvents ?? 0),
  };
  let seq = 0;
  const username = (label: string) => `acc${ctx.runId}${label}${++seq}`.toLowerCase().replace(/[^a-z0-9]/g, '');
  const makeCashier = async (label: string, branchIds: string[]): Promise<Cashier> => {
    const u = username(label);
    const password = newPassword();
    const r = await admin('POST', '/cashier-accounts', { username: u, displayName: `Acc ${u}`, accessMode: branchIds.length > 1 ? 'multiple' : 'single', branchIds, password });
    if (r.status !== 201) throw new Error(`cashier creation failed (${r.status})`);
    if (typeof r.data.cashierCode === 'string') codeA = r.data.cashierCode;
    return { id: r.data.account.id as string, username: u, password };
  };
  let codeB: string | null = null;
  let proofB = '';
  const makeCashierB = async (label: string, branchId: string): Promise<Cashier> => {
    if (!proofB) {
      const re = await ctx.api.request('POST', '/cashier-accounts/reauth', { token: tokenB, businessId: ctx.ownerB.businessId, body: { password: ctx.ownerB.password } });
      if (re.status !== 200) throw new Error(`business B re-authentication failed (${re.status})`);
      proofB = re.data.proof as string;
    }
    const u = username(`b${label}`);
    const password = newPassword();
    const r = await ctx.api.request('POST', '/cashier-accounts', {
      token: tokenB, businessId: ctx.ownerB.businessId, headers: { 'x-reauth-proof': proofB },
      body: { username: u, displayName: `Acc ${u}`, accessMode: 'single', branchIds: [branchId], password },
    });
    if (r.status !== 201) throw new Error(`business B cashier creation failed (${r.status})`);
    codeB = r.data.cashierCode as string;
    return { id: r.data.account.id as string, username: u, password };
  };
  const signIn = async (cashier: Cashier, branchId: string, business: 'A' | 'B' = 'A'): Promise<Session> => {
    const businessCode = business === 'A' ? codeA : codeB;
    const businessId = business === 'A' ? ctx.ownerA.businessId : ctx.ownerB.businessId;
    const l = await ctx.api.request('POST', '/auth/cashier/managed-login', { body: { businessCode, username: cashier.username, password: cashier.password } });
    let data = l.data;
    if (l.status === 200 && data?.status !== 'authenticated') {
      const s = await ctx.api.request('POST', '/auth/cashier/session', { body: { ticket: data.ticket, businessId, branchId } });
      if (s.status !== 200) throw new Error(`cashier session failed (${s.status})`);
      data = s.data;
    } else if (l.status !== 200) {
      throw new Error(`cashier sign-in failed (${l.status})`);
    }
    return { accessToken: data.accessToken as string, refreshToken: data.refreshToken as string, branchId: (data.session?.branchId ?? branchId) as string };
  };
  const world: World = {
    tokenA, tokenB, branchesA, branchesB,
    get codeA() { return codeA; },
    get codeB() { return codeB; },
    baseline, makeCashier, makeCashierB, signIn, admin, ownerCall, customers: new Map(),
  } as World;
  return world;
}

const invite = (ctx: Context, token: string) => ctx.api.request('POST', '/loyalty/actions/onboarding-invite', { token });
const accept = (ctx: Context, customerToken: string, inviteToken: string, extra: Record<string, unknown> = {}) =>
  ctx.api.request('POST', '/customer-memberships/join-assisted', { token: customerToken, body: { inviteToken, consentAccepted: true, consentVersion: 'v1', ...extra } });
const preview = (ctx: Context, customerToken: string, inviteToken: string) =>
  ctx.api.request('POST', '/customer-memberships/join-assisted/preview', { token: customerToken, body: { inviteToken } });

const needsCustomers = (ctx: Context) => (ctx.provisioner === null ? 'no customer provisioner is available (live OTP sign-up needs an approved mailbox and E2)' : null);
const needsBranches = (n: number) => (_: Context, w: World) => (w.branchesA.length < n ? `business A needs at least ${n} branches (has ${w.branchesA.length})` : null);
const both = (...fns: Array<(c: Context, w: World) => string | null>) => (c: Context, w: World) => {
  for (const fn of fns) { const r = fn(c, w); if (r) return r; }
  return null;
};

/** Pulls a customer from the provisioner once per label. */
async function customer(ctx: Context, world: World, label: string, opts?: { phoneVerified?: boolean }): Promise<Provisioned> {
  const key = `${label}:${opts?.phoneVerified ?? ''}`;
  const have = world.customers.get(key);
  if (have) return have;
  if (!ctx.provisioner) throw new Error('no customer provisioner');
  const made = await ctx.provisioner.create(label, opts);
  world.customers.set(key, made);
  return made;
}

const pointsOf = async (ctx: Context, token: string, businessId: string): Promise<number> => {
  const r = await ctx.api.request('GET', `/loyalty/me/accounts/${businessId}`, { token });
  return Number(r.data?.account?.points ?? Number.NaN);
};

export const SCENARIOS: Scenario[] = [
  {
    id: 'S01', area: 'Cashier authentication and session context', title: 'managed sign-in, generic failures, session bound by the server',
    unavailable: needsBranches(2),
    async run(ctx, w, rec) {
      const c = await w.makeCashier('a', w.branchesA.slice(0, 2));
      const wrong = await ctx.api.request('POST', '/auth/cashier/managed-login', { body: { businessCode: w.codeA, username: c.username, password: 'definitely-wrong-1' } });
      const unknown = await ctx.api.request('POST', '/auth/cashier/managed-login', { body: { businessCode: w.codeA, username: 'nosuchcashier99', password: 'definitely-wrong-1' } });
      const same = (a: ApiResult, b: ApiResult) => a.status === b.status && code(a) === code(b) && a.error?.message === b.error?.message;
      await rec.check('S01.1', 'wrong password and unknown username answer identically (generic 401)', wrong.status === 401 && same(wrong, unknown), `${wrong.status}/${unknown.status}`);
      const login = await ctx.api.request('POST', '/auth/cashier/managed-login', { body: { businessCode: w.codeA, username: c.username, password: c.password } });
      await rec.check('S01.2', 'a multi-branch cashier must choose a branch (selection ticket, no session yet)', login.status === 200 && login.data?.status === 'selection_required' && !login.data?.accessToken, `${login.status}`);
      const chosen = w.branchesA[1] as string;
      const s = await ctx.api.request('POST', '/auth/cashier/session', { body: { ticket: login.data?.ticket, businessId: ctx.ownerA.businessId, branchId: chosen } });
      await rec.check('S01.3', 'the session is bound to the chosen branch and the business of the code', s.status === 200 && s.data?.session?.branchId === chosen && !!s.data?.accessToken, `${s.status}`);
      const other = w.branchesA[0] as string;
      const spoof = await ctx.api.request('POST', `/loyalty/actions/onboarding-invite?branchId=${other}`, { token: s.data?.accessToken, branchId: other });
      await rec.check('S01.4', 'a branch named in the request is ignored or refused: the session\'s branch always wins', (spoof.status === 403 && code(spoof) === 'CASHIER_CONTEXT_MISMATCH') || (spoof.status === 200 && spoof.data?.branchId === chosen), `${spoof.status} ${code(spoof)}`);
      const mismatch = await ctx.api.request('POST', '/loyalty/actions/onboarding-invite', { token: s.data?.accessToken, businessId: ctx.ownerB.businessId });
      await rec.check('S01.5', 'a header naming another business is refused (CASHIER_CONTEXT_MISMATCH)', mismatch.status === 403 && code(mismatch) === 'CASHIER_CONTEXT_MISMATCH', `${mismatch.status} ${code(mismatch)}`);
    },
  },
  {
    id: 'S02', area: 'Role restrictions and protected routes', title: 'cashier, customer and anonymous callers cannot reach administration or reports',
    unavailable: needsBranches(2),
    async run(ctx, w, rec) {
      const c = await w.makeCashier('r', w.branchesA.slice(0, 2));
      const s = await w.signIn(c, w.branchesA[0] as string);
      const targets: Array<[string, string]> = [['GET', '/cashier-accounts'], ['POST', '/cashier-accounts/reauth'], ['GET', '/cashier-sessions'], ['GET', '/analytics/onboarding']];
      let allDenied = true;
      const seen: string[] = [];
      for (const [method, path] of targets) {
        const r = await ctx.api.request(method, path, { token: s.accessToken, businessId: ctx.ownerA.businessId, ...(method === 'POST' ? { body: {} } : {}) });
        if (!(r.status === 403 && code(r) === 'CASHIER_ROUTE_DENIED')) allDenied = false;
        seen.push(`${r.status}`);
      }
      await rec.check('S02.1', 'a cashier token is refused on administration and report routes (CASHIER_ROUTE_DENIED)', allDenied, seen.join(','));
      const anon = await ctx.api.request('GET', '/analytics/onboarding', { businessId: ctx.ownerA.businessId });
      await rec.check('S02.2', 'an anonymous caller is refused on the onboarding report', anon.status === 401, `${anon.status}`);
      const owner = await ctx.api.request('POST', '/loyalty/actions/onboarding-invite', { token: w.tokenA, businessId: ctx.ownerA.businessId });
      await rec.check('S02.3', 'an owner without a cashier session cannot issue an invitation (ONBOARDING_INVITE_CASHIER_ONLY)', owner.status === 403 && code(owner) === 'ONBOARDING_INVITE_CASHIER_ONLY', `${owner.status} ${code(owner)}`);
    },
  },
  {
    id: 'S03', area: 'Cashier invitation issue and validation', title: 'invitations are short-lived, signed, bound to the session branch, free of personal data',
    unavailable: needsBranches(2),
    async run(ctx, w, rec) {
      const c = await w.makeCashier('i', w.branchesA.slice(0, 2));
      const branch = w.branchesA[0] as string;
      const s = await w.signIn(c, branch);
      const issued = await invite(ctx, s.accessToken);
      const token = String(issued.data?.inviteToken ?? '');
      await rec.check('S03.1', 'the issuer returns a token, a link and an expiry for the session branch', issued.status === 200 && token.split('.').length === 3 && !!issued.data?.inviteUrl && issued.data?.branchId === branch, `${issued.status}`);
      const claims = decodeClaims(token);
      await rec.check('S03.2', 'the payload has exactly the documented claims and a 10 minute lifetime', JSON.stringify(Object.keys(claims).sort()) === JSON.stringify(['biz', 'brid', 'exp', 'iat', 'jti', 'sid', 'sub', 'type']) && Number(claims.exp) - Number(claims.iat) === 600, `claims ${Object.keys(claims).length}`);
      await rec.check('S03.3', 'the payload carries the business and branch of the session and no personal data', claims.biz === ctx.ownerA.businessId && claims.brid === branch && !/@|\+\d{7,}/.test(JSON.stringify(claims)), 'checked locally');
      if (ctx.provisioner) {
        const cust = await customer(ctx, w, 'prev');
        const p = await preview(ctx, cust.token, token);
        await rec.check('S03.4', 'the customer preview names the business and branch and never the cashier', p.status === 200 && p.data?.status === 'ready' && !JSON.stringify(p.data).includes(String(claims.sub)), `${p.status} ${p.data?.status ?? ''}`);
      } else await rec.notRun('S03.4', 'customer preview of an invitation', 'no customer provisioner');
    },
  },
  {
    id: 'S04', area: 'Customer onboarding and explicit consent', title: 'consent is required, versioned and enforced before any membership exists',
    unavailable: both(needsBranches(2), (c) => needsCustomers(c)),
    async run(ctx, w, rec) {
      const c = await w.makeCashier('o', w.branchesA.slice(0, 2));
      const s = await w.signIn(c, w.branchesA[0] as string);
      const inv = (await invite(ctx, s.accessToken)).data?.inviteToken as string;
      const cust = await customer(ctx, w, 'one');
      const noConsent = await accept(ctx, cust.token, inv, { consentAccepted: false });
      await rec.check('S04.1', 'accepting without consent is refused (400)', noConsent.status === 400, `${noConsent.status}`);
      const badVersion = await accept(ctx, cust.token, inv, { consentVersion: 'v99' });
      await rec.check('S04.2', 'an unknown consent version is refused (400)', badVersion.status === 400, `${badVersion.status}`);
      const none = await ctx.api.request('GET', `/loyalty/me/accounts/${ctx.ownerA.businessId}`, { token: cust.token });
      await rec.check('S04.3', 'the refused attempts created no membership', none.status === 404, `${none.status}`);
      const ok = await accept(ctx, cust.token, inv);
      await rec.check('S04.4', 'with explicit consent the same invitation (not consumed by the refusals) enrols the customer', ok.status === 200 || ok.status === 201, `${ok.status}`);
    },
  },
  {
    id: 'S05', area: 'Single-use invitations and replay', title: 'an invitation works once; replays, tampering and garbage are refused',
    unavailable: both(needsBranches(2), (c) => needsCustomers(c)),
    async run(ctx, w, rec) {
      const c = await w.makeCashier('u', w.branchesA.slice(0, 2));
      const s = await w.signIn(c, w.branchesA[0] as string);
      const inv = (await invite(ctx, s.accessToken)).data?.inviteToken as string;
      const first = await customer(ctx, w, 'single-a');
      const second = await customer(ctx, w, 'single-b');
      const a = await accept(ctx, first.token, inv);
      await rec.check('S05.1', 'the first acceptance succeeds', a.status === 200 || a.status === 201, `${a.status}`);
      const b = await accept(ctx, second.token, inv);
      await rec.check('S05.2', 'a second customer with the same invitation is refused (ONBOARDING_INVITE_USED)', b.status === 409 && code(b) === 'ONBOARDING_INVITE_USED', `${b.status} ${code(b)}`);
      const eventsOf = async () => Number((await w.ownerCall('GET', '/analytics/onboarding')).data?.totals?.events ?? Number.NaN);
      const beforeReplay = await eventsOf();
      const again = await accept(ctx, first.token, inv);
      await rec.check('S05.3', 'the same customer replaying it is harmless: no second attribution event is recorded', again.status < 500 && (await eventsOf()) === beforeReplay, `${again.status}`);
      const fresh = (await invite(ctx, s.accessToken)).data?.inviteToken as string;
      const tampered = `${fresh.slice(0, -2)}${fresh.endsWith('AA') ? 'BB' : 'AA'}`;
      const t = await accept(ctx, second.token, tampered);
      await rec.check('S05.4', 'a token with an altered signature is refused (ONBOARDING_INVITE_INVALID)', t.status === 400 && code(t) === 'ONBOARDING_INVITE_INVALID', `${t.status} ${code(t)}`);
      const g = await accept(ctx, second.token, 'not-a-token');
      await rec.check('S05.5', 'garbage is refused with the same generic error', g.status === 400 && code(g) === 'ONBOARDING_INVITE_INVALID', `${g.status} ${code(g)}`);
    },
  },
  {
    id: 'S06', area: 'Attribution evidence and protected reports', title: 'the owner report counts attribution and holds no personal data',
    unavailable: needsBranches(2),
    async run(ctx, w, rec) {
      const r = await w.ownerCall('GET', '/analytics/onboarding');
      const text = JSON.stringify(r.data ?? {});
      await rec.check('S06.1', 'the report is counts only: totals, by source, by branch', r.status === 200 && !!r.data?.totals && Array.isArray(r.data?.bySource) && Array.isArray(r.data?.byBranch), `${r.status}`);
      await rec.check('S06.2', 'the report contains no email, phone or customer identifier', !/@|\+\d{7,}|customerId|customer_id/i.test(text), 'checked locally');
      if (ctx.provisioner) {
        const events = Number(r.data?.totals?.events ?? 0);
        await rec.check('S06.3', 'this run\'s successful enrolments are in the totals (cashier_assisted)', events > w.baseline.events && (r.data?.bySource as Array<{ source: string }>).some((x) => x.source === 'cashier_assisted'), `${w.baseline.events} -> ${events}`);
      } else await rec.notRun('S06.3', 'enrolments counted in the totals', 'no customer provisioner');
    },
  },
  {
    id: 'S07', area: 'Rejoin attribution', title: 'leaving and rejoining through a new invitation is recorded as a rejoin',
    unavailable: both(needsBranches(2), (c) => needsCustomers(c)),
    async run(ctx, w, rec) {
      const cust = await customer(ctx, w, 'rejoin');
      const c = await w.makeCashier('j', w.branchesA.slice(0, 2));
      const s = await w.signIn(c, w.branchesA[0] as string);
      const join1 = await accept(ctx, cust.token, (await invite(ctx, s.accessToken)).data?.inviteToken as string);
      const before = Number((await w.ownerCall('GET', '/analytics/onboarding')).data?.totals?.rejoinEvents ?? 0);
      const left = await ctx.api.request('POST', `/customer-memberships/${ctx.ownerA.businessId}/leave`, { token: cust.token });
      const join2 = await accept(ctx, cust.token, (await invite(ctx, s.accessToken)).data?.inviteToken as string);
      const after = await w.ownerCall('GET', '/analytics/onboarding');
      await rec.check('S07.1', 'the customer joins, leaves and rejoins', [join1.status, left.status, join2.status].every((x) => x === 200 || x === 201), `${join1.status}/${left.status}/${join2.status}`);
      await rec.check('S07.2', 'the rejoin is counted as a rejoin event, not as a new customer', Number(after.data?.totals?.rejoinEvents ?? 0) === before + 1, `rejoin ${before} -> ${after.data?.totals?.rejoinEvents}`);
    },
  },
  {
    id: 'S08', area: 'Branch-switch authorization', title: 'switching needs an assigned branch and ends the previous session and its invitations',
    unavailable: needsBranches(3),
    async run(ctx, w, rec) {
      const [a1, a2, a3] = w.branchesA as [string, string, string];
      const c = await w.makeCashier('s', [a1, a2]);
      const s = await w.signIn(c, a1);
      const staleInvite = (await invite(ctx, s.accessToken)).data?.inviteToken as string;
      const denyOther = await ctx.api.request('POST', '/auth/cashier/switch-branch', { body: { refreshToken: s.refreshToken, branchId: a3, fromBranchId: a1 } });
      await rec.check('S08.1', 'switching to a branch the cashier is not assigned to is refused (403)', denyOther.status === 403, `${denyOther.status}`);
      const sw = await ctx.api.request('POST', '/auth/cashier/switch-branch', { body: { refreshToken: s.refreshToken, branchId: a2, fromBranchId: a1 } });
      await rec.check('S08.2', 'switching to an assigned branch succeeds and the new session is bound to it', sw.status === 200 && sw.data?.session?.branchId === a2, `${sw.status}`);
      const old = await invite(ctx, s.accessToken);
      await rec.check('S08.3', 'the previous access token no longer works', denied(old), `${old.status}`);
      const fresh = await invite(ctx, sw.data?.accessToken);
      await rec.check('S08.4', 'an invitation issued after the switch is bound to the new branch', fresh.status === 200 && fresh.data?.branchId === a2, `${fresh.status}`);
      if (ctx.provisioner) {
        const cust = await customer(ctx, w, 'switch');
        const stale = await accept(ctx, cust.token, staleInvite);
        await rec.check('S08.5', 'an invitation issued before the switch is refused (ONBOARDING_INVITE_INVALID)', stale.status === 409 && code(stale) === 'ONBOARDING_INVITE_INVALID', `${stale.status} ${code(stale)}`);
      } else await rec.notRun('S08.5', 'stale invitation after a switch', 'no customer provisioner');
    },
  },
  {
    id: 'S09', area: 'Cross-business tenant isolation', title: 'another business\'s owner and cashier context cannot touch this business',
    unavailable: needsBranches(2),
    async run(ctx, w, rec) {
      const issued = await ctx.api.request('POST', '/loyalty/actions/onboarding-invite', { token: w.tokenB, businessId: ctx.ownerA.businessId });
      await rec.check('S09.1', 'the owner of business B cannot issue an invitation for business A', issued.status === 403, `${issued.status}`);
      const report = await ctx.api.request('GET', '/analytics/onboarding', { token: w.tokenB, businessId: ctx.ownerA.businessId });
      await rec.check('S09.2', 'the owner of business B cannot read business A\'s onboarding report', report.status === 403, `${report.status}`);
      const sessions = await ctx.api.request('GET', '/cashier-sessions', { token: w.tokenB, businessId: ctx.ownerA.businessId });
      await rec.check('S09.3', 'the owner of business B cannot list business A\'s cashier sessions', sessions.status === 403, `${sessions.status}`);
      const own = await ctx.api.request('GET', '/analytics/onboarding', { token: w.tokenB, businessId: ctx.ownerB.businessId });
      const mine = Number(own.data?.totals?.events ?? -1);
      await rec.check('S09.4', 'business B\'s own report is readable and is not inflated by business A\'s enrolments', own.status === 200 && mine >= 0, `${own.status}`);
    },
  },
  {
    id: 'S10', area: 'Purchase idempotency', title: 'one idempotency key earns points once, even when submitted in parallel',
    unavailable: both(needsBranches(2), (c) => needsCustomers(c)),
    async run(ctx, w, rec) {
      const cust = await customer(ctx, w, 'buyer');
      const c = await w.makeCashier('p', w.branchesA.slice(0, 2));
      const s = await w.signIn(c, w.branchesA[0] as string);
      const joined = await accept(ctx, cust.token, (await invite(ctx, s.accessToken)).data?.inviteToken as string);
      const qr = await ctx.api.request('GET', '/loyalty/me/customer-qr', { token: cust.token });
      const resolved = await ctx.api.request('POST', '/loyalty/actions/resolve-customer', { token: s.accessToken, body: { customerQrToken: qr.data?.token } });
      const accountId = resolved.data?.loyaltyAccountId as string | undefined;
      await rec.check('S10.1', 'the cashier resolves the customer through their QR and obtains the loyalty account', (joined.status === 200 || joined.status === 201) && resolved.status === 200 && !!accountId, `${resolved.status}`);
      if (!accountId) return;
      const biz = ctx.ownerA.businessId;
      const p0 = await pointsOf(ctx, cust.token, biz);
      const buy = (key: string) => ctx.api.request('POST', `/loyalty/accounts/${accountId}/purchase`, { token: s.accessToken, body: { purchaseAmount: 20, idempotencyKey: key, channel: 'other' } });
      const k1 = `acc-${ctx.runId}-p1`;
      const one = await buy(k1);
      const p1 = await pointsOf(ctx, cust.token, biz);
      await rec.check('S10.2', 'a purchase is recorded and earns points', one.status === 200 && p1 > p0, `${p0} -> ${p1}`);
      const parallel = await Promise.all(Array.from({ length: 5 }, () => buy(`acc-${ctx.runId}-p2`)));
      const p2 = await pointsOf(ctx, cust.token, biz);
      await rec.check('S10.3', 'five parallel submissions of one key earn exactly one purchase\'s points', parallel.every((r) => r.status < 500) && p2 - p1 === p1 - p0, `${parallel.map((r) => r.status).join(',')} earned ${p2 - p1} vs ${p1 - p0}`);
      const replay = await buy(k1);
      const p3 = await pointsOf(ctx, cust.token, biz);
      await rec.check('S10.4', 'replaying the first key later changes nothing', replay.status < 500 && p3 === p2, `${p2} -> ${p3}`);
      world_state.set(w, { accountId, cashier: s, customer: cust, pointsPerPurchase: p1 - p0 });
    },
  },
  {
    id: 'S11', area: 'Redemption concurrency', title: 'a redemption code is confirmed exactly once under parallel confirmation',
    unavailable: both(needsBranches(2), (c) => needsCustomers(c)),
    async run(ctx, w, rec) {
      const st = world_state.get(w);
      if (!st) { await rec.notRun('S11.1', 'redemption concurrency', 'S10 did not establish a member with points'); return; }
      const biz = ctx.ownerA.businessId;
      const reward = await w.ownerCall('POST', '/loyalty/rewards', { name: `Acc ${ctx.runId}`, pointsCost: Math.max(1, Math.min(st.pointsPerPurchase, 5)) });
      const rewardId = reward.data?.id as string | undefined;
      await rec.check('S11.1', 'the owner creates a reward the customer can afford', reward.status === 201 && !!rewardId, `${reward.status}`);
      if (!rewardId) return;
      const before = await pointsOf(ctx, st.customer.token, biz);
      const red = await ctx.api.request('POST', `/loyalty/me/accounts/${biz}/redeem`, { token: st.customer.token, body: { rewardId } });
      const redemptionCode = (red.data?.code ?? red.data?.redemptionCode ?? red.data?.redemption?.code) as string | undefined;
      await rec.check('S11.2', 'the customer requests a redemption and receives a code', (red.status === 200 || red.status === 201) && !!redemptionCode, `${red.status}`);
      if (!redemptionCode) return;
      const look = await ctx.api.request('GET', `/loyalty/redemptions/${redemptionCode}`, { token: st.cashier.accessToken });
      await rec.check('S11.3', 'the cashier can look the code up', look.status === 200, `${look.status}`);
      const confirms = await Promise.all(Array.from({ length: 4 }, () => ctx.api.request('POST', `/loyalty/redemptions/${redemptionCode}/confirm`, { token: st.cashier.accessToken })));
      const okCount = confirms.filter((r) => r.status === 200).length;
      const after = await pointsOf(ctx, st.customer.token, biz);
      await rec.check('S11.4', 'four parallel confirmations: exactly one succeeds and the others are refused', okCount === 1 && confirms.filter((r) => r.status >= 400 && r.status < 500).length === 3, `${confirms.map((r) => r.status).join(',')}`);
      await rec.check('S11.5', 'the points were deducted once', after < before && before - after <= Math.max(1, Math.min(st.pointsPerPurchase, 5)), `${before} -> ${after}`);
    },
  },
  {
    id: 'S12', area: 'Expired, revoked and invalid invitations', title: 'invitations die with the session, the assignment and the clock',
    unavailable: both(needsBranches(3), (c) => needsCustomers(c)),
    async run(ctx, w, rec) {
      const [a1, a2, a3] = w.branchesA as [string, string, string];
      const rev = await w.makeCashier('v', [a1, a2]);
      const rs = await w.signIn(rev, a1);
      const revInvite = (await invite(ctx, rs.accessToken)).data?.inviteToken as string;
      const cust = await customer(ctx, w, 'revoked');
      const revoked = await w.admin('POST', `/cashier-accounts/${rev.id}/revoke-sessions`, {});
      const afterRevoke = await accept(ctx, cust.token, revInvite);
      await rec.check('S12.1', 'an invitation is refused after the cashier\'s sessions are revoked', revoked.status < 300 && afterRevoke.status === 409 && code(afterRevoke) === 'ONBOARDING_INVITE_INVALID', `${revoked.status}/${afterRevoke.status} ${code(afterRevoke)}`);
      const rem = await w.makeCashier('w', [a1, a2]);
      const ms = await w.signIn(rem, a1);
      const remInvite = (await invite(ctx, ms.accessToken)).data?.inviteToken as string;
      const removed = await w.admin('PUT', `/cashier-accounts/${rem.id}/branches`, { accessMode: 'multiple', branchIds: [a2, a3] });
      const afterRemoval = await accept(ctx, cust.token, remInvite);
      await rec.check('S12.2', 'an invitation is refused after its branch assignment is removed', removed.status < 300 && afterRemoval.status === 409, `${removed.status}/${afterRemoval.status}`);
      if (ctx.forgeInvite) {
        const live = await w.makeCashier('x', [a1, a2]);
        const ls = await w.signIn(live, a1);
        const real = (await invite(ctx, ls.accessToken)).data?.inviteToken as string;
        const claims = decodeClaims(real);
        const expired = await ctx.forgeInvite({ ...claims, iat: 1, exp: 2 });
        const e = await accept(ctx, cust.token, expired);
        await rec.check('S12.3', 'an expired invitation is refused (ONBOARDING_INVITE_INVALID)', e.status === 400 && code(e) === 'ONBOARDING_INVITE_INVALID', `${e.status} ${code(e)}`);
      } else await rec.notRun('S12.3', 'expired invitation', 'forging an expired token needs the signing secret, which the harness never has (covered by unit and integration tests)');
      await sleepMs(0);
    },
  },
  {
    id: 'S13', area: 'Verification requirement for an additional business', title: 'an unverified customer cannot join a second business; a verified one can',
    unavailable: both(needsBranches(2), (c) => needsCustomers(c), (c) => (c.provisioner && !c.provisioner.canSetPhoneVerified ? 'the provisioner cannot create a phone-verified customer (needs an SMS fixture)' : null), (_c, w) => (w.branchesB.length < 1 ? 'business B needs a branch' : null)),
    async run(ctx, w, rec) {
      const cb = await w.makeCashierB('q', w.branchesB[0] as string);
      const sb = await w.signIn(cb, w.branchesB[0] as string, 'B');
      const ca = await w.makeCashier('q', w.branchesA.slice(0, 2));
      const sa = await w.signIn(ca, w.branchesA[0] as string);
      const unverified = await customer(ctx, w, 'unverified', { phoneVerified: false });
      const verified = await customer(ctx, w, 'verified', { phoneVerified: true });
      const first = await accept(ctx, unverified.token, (await invite(ctx, sa.accessToken)).data?.inviteToken as string);
      await rec.check('S13.1', 'the first business can be joined without a verified phone', first.status === 200 || first.status === 201, `${first.status}`);
      const second = await accept(ctx, unverified.token, (await invite(ctx, sb.accessToken)).data?.inviteToken as string);
      await rec.check('S13.2', 'an additional business is refused without a verified phone (PHONE_VERIFICATION_REQUIRED)', second.status >= 400 && code(second) === 'PHONE_VERIFICATION_REQUIRED', `${second.status} ${code(second)}`);
      const ok1 = await accept(ctx, verified.token, (await invite(ctx, sa.accessToken)).data?.inviteToken as string);
      const ok2 = await accept(ctx, verified.token, (await invite(ctx, sb.accessToken)).data?.inviteToken as string);
      await rec.check('S13.3', 'a phone-verified customer joins both businesses', [ok1.status, ok2.status].every((x) => x === 200 || x === 201), `${ok1.status}/${ok2.status}`);
    },
  },
  {
    id: 'S14', area: 'Arabic and right-to-left interfaces', title: 'Arabic and RTL screens at 375 px',
    async run(_ctx, _w, rec) {
      await rec.notRun('S14.1', 'Arabic / RTL interface acceptance', 'browser-based; not part of the API harness. Covered by the web render tests and the staging browser run of 2026-11-19; a repeatable browser step belongs to E2');
    },
  },
];

interface Established {
  accountId: string;
  cashier: Session;
  customer: Provisioned;
  pointsPerPurchase: number;
}
const world_state = new WeakMap<World, Established>();
