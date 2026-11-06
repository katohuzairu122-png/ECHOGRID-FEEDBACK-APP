import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Bindings } from '../config/env';
import { AppError } from '../lib/errors';
import { ok } from '../lib/response';
import { createDb, type Database } from '../db/client';
import { createRepositories } from '../repositories';
import { rateLimit } from '../middleware/rate-limit';
import { sha256Hex } from '../billing/stripe-read/bundle-builder';
import {
  AdminAuthorityError, authenticateAdminSession, createSessionRevalidator, ReadAuthorizationAdminService, createWorkloadAuthority, type AdminSessionDeps, type AdminSessionDenial, type TrustedAdminContext,
  type WorkloadConfigSource, type WorkloadEnvironment,
} from '../billing/stripe-read';
import { ReadAuthorizationLifecycleError } from '../billing/stripe-read/durable-authorization';

/**
 * S08-D1D3-DEV-12: the INTERNAL ADMINISTRATOR API for the durable Stripe read-authorization lifecycle. It exposes proposal, approval, revocation, status, audit history and a READ-ONLY view of the
 * approval policy. It executes no Stripe request, reads no secret or signing key, moves no ledger row, and has no endpoint that can enable `approval_enabled` (that switch stays an owner-controlled, out-of-band decision).
 *
 * `/internal` is NOT the security boundary. Independent controls, evaluated in this order, each failing closed:
 *   1. Deployment restriction: the surface does not exist (404) unless INTERNAL_STRIPE_READ_ADMIN_API = 'enabled'.
 *   2. Gateway control: a shared gateway token (>= 32 chars, constant-time compare) must accompany the request; an unconfigured token means 404.
 *   3. Browser origin refusal: a request carrying an Origin header is refused (this is a server-to-server surface; there is no cookie authentication, so CSRF does not apply, and no CORS grant is made here).
 *   4. Rate limiting (existing strict limiter), a JSON content type and a small body limit.
 *   5. Administrator session: the signed, session-bound access token is verified server-side, the exact persisted session and the administrator are resolved, and the TrustedAdminContext is created only here.
 *      The administrator identity is NEVER read from a body field, header or query parameter. Every privileged service call re-verifies the exact session (DEV-11-R1), so a revoked session loses access at once.
 *   6. The database independently enforces administrator status, distinct proposer/approver, terminal revocation, expiry, row locks and audit (DEV-10).
 * Responses are never cached, never contain a token, session id, secret or signing key, and administrators appear only as opaque references.
 */
type Vars = { adminCtx: TrustedAdminContext; db: Database; requestCorrelation: string; userId: string };
type Env = { Bindings: Bindings; Variables: Vars };

export interface AdminApiDeps {
  /** Opens the request-scoped database. The default is the Hyperdrive-backed `createDb`. */
  openDb(env: Bindings): Promise<{ db: Database; close(): Promise<void> }>;
  clock(): number;
  /** Builds the administrator-session dependencies (persisted users and session records). Default: the real repositories. */
  sessionDeps(db: Database, env: Bindings, clock: () => number): AdminSessionDeps;
  /** Trusted workload configuration of the verifier workload. NULL (the default) means none is provisioned: proposals fail closed. */
  workloadConfig: WorkloadConfigSource | null;
  /** Rate limiting can be replaced in tests; the default uses the existing strict limiter. */
  limiter?: ReturnType<typeof rateLimit>;
}

const defaultDeps: AdminApiDeps = {
  openDb: env => createDb(env.HYPERDRIVE),
  clock: () => Date.now(),
  sessionDeps(db, env, clock) { const r = createRepositories(db); return { accessSecret: env.JWT_ACCESS_SECRET, users: r.users, sessions: r.refreshTokens, clock }; },
  workloadConfig: null,
};

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const PRINTABLE = z.string().regex(/^[!-~]{1,255}$/);
/** Only the two read methods the closed registry can ever perform. The other four registry names, and anything else, are rejected before the database is reached. */
const METHOD = z.enum(['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE']);
export const ProposalBody = z.object({
  businessId: UUID,
  accountId: z.string().regex(/^acct_[A-Za-z0-9]{1,128}$/),
  methodId: METHOD,
  realm: z.literal('test'),
  workloadId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$/),
  validFromMs: z.number().int().min(0).max(8_640_000_000_000_000),
  expiresAtMs: z.number().int().min(1).max(8_640_000_000_000_000),
  inventoryRevision: PRINTABLE,
}).strict();
export const ApprovalBody = z.object({ evidenceRef: PRINTABLE }).strict();
export const RevokeBody = z.object({ reason: z.string().regex(/^[A-Z_]{1,64}$/) }).strict();
const AuditQuery = z.object({ businessId: UUID, limit: z.coerce.number().int().min(1).max(100).default(50), afterVersion: z.coerce.number().int().min(0).max(1_000_000).default(0) }).strict();
const ScopeQuery = z.object({ businessId: UUID }).strict();

/** The INVENTORY record every authorization belongs to; fixed by the server, never by the caller. */
const INVENTORY_RECORD_ID = 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001' as const;
const MAX_BODY_BYTES = 4096;

const AUTH_FAILURE: Record<AdminSessionDenial, readonly [401 | 403 | 500, string]> = {
  ANONYMOUS: [401, 'UNAUTHENTICATED'], MALFORMED_CREDENTIAL: [401, 'UNAUTHENTICATED'], SESSION_EXPIRED: [401, 'UNAUTHENTICATED'], INVALID_TOKEN: [401, 'UNAUTHENTICATED'],
  SESSION_BINDING_MISSING: [401, 'UNAUTHENTICATED'], SESSION_REVOKED: [401, 'UNAUTHENTICATED'], ACCOUNT_NOT_FOUND: [401, 'UNAUTHENTICATED'],
  IMPERSONATED_SESSION: [403, 'ADMIN_ACCESS_DENIED'], ACCOUNT_NOT_ACTIVE: [403, 'ADMIN_ACCESS_DENIED'], NOT_PLATFORM_ADMIN: [403, 'ADMIN_ACCESS_DENIED'],
  VERIFICATION_UNAVAILABLE: [500, 'ADMIN_AUTH_UNAVAILABLE'],
};
const LIFECYCLE_FAILURE: Record<string, readonly [400 | 403 | 404 | 409 | 422 | 500, string]> = {
  INVALID_INPUT: [422, 'INVALID_REQUEST'], ADMIN_REQUIRED: [403, 'ADMIN_ACCESS_DENIED'], SELF_APPROVAL: [403, 'SELF_APPROVAL_REFUSED'], APPROVAL_DISABLED: [409, 'APPROVAL_POLICY_DISABLED'],
  EXPIRED: [409, 'AUTHORIZATION_EXPIRED'], REVOKED_TERMINAL: [409, 'AUTHORIZATION_REVOKED'], ALREADY_APPROVED: [409, 'ALREADY_APPROVED'], NOT_FOUND: [404, 'NOT_FOUND'],
  INVALID_TRANSITION: [409, 'INVALID_TRANSITION'], DUPLICATE_LIVE: [409, 'DUPLICATE_ACTIVE_AUTHORIZATION'], NOT_PERMITTED: [500, 'AUTHORIZATION_STORE_UNAVAILABLE'], UNAVAILABLE: [500, 'AUTHORIZATION_STORE_UNAVAILABLE'],
};

const constantTimeEqual = (a: string, b: string): boolean => {
  const x = new TextEncoder().encode(a); const y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
};
const notFound = () => new AppError('Not found.', 404, 'NOT_FOUND');
const actorRef = async (id: string) => (await sha256Hex(`stripe-read-audit-actor|${id}`)).slice(0, 16);

function mapFailure(e: unknown): never {
  if (e instanceof AppError) throw e;
  if (e instanceof AdminAuthorityError) {
    if (e.code === 'SESSION_NOT_LIVE' || e.code === 'CONTEXT_STALE') throw new AppError('Administrator session is no longer valid.', 401, 'UNAUTHENTICATED');
    throw new AppError('Administrator authority could not be established.', 500, 'ADMIN_AUTH_UNAVAILABLE');
  }
  if (e instanceof ReadAuthorizationLifecycleError) {
    const [status, code] = LIFECYCLE_FAILURE[e.code] ?? [500, 'AUTHORIZATION_STORE_UNAVAILABLE'];
    throw new AppError(status === 500 ? 'The authorization store is unavailable.' : 'The request was refused.', status, code);
  }
  console.error('stripe-read admin api: unexpected failure'); // never the error object: it could carry connection detail
  throw new AppError('The authorization store is unavailable.', 500, 'AUTHORIZATION_STORE_UNAVAILABLE');
}

export function createStripeReadAdminRoutes(overrides: Partial<AdminApiDeps> = {}) {
  const deps: AdminApiDeps = { ...defaultDeps, ...overrides };
  const routes = new Hono<Env>();

  // 1-3. deployment restriction, gateway control, browser-origin refusal. Failures here are indistinguishable from "no such route".
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store'); c.header('Pragma', 'no-cache');
    const env = c.env;
    const gateway = env.INTERNAL_API_GATEWAY_TOKEN;
    if (env.INTERNAL_STRIPE_READ_ADMIN_API !== 'enabled' || typeof gateway !== 'string' || gateway.length < 32) throw notFound();
    const presented = c.req.header('x-internal-gateway-token');
    if (typeof presented !== 'string' || !constantTimeEqual(presented, gateway)) throw notFound();
    if (c.req.header('origin') !== undefined) throw new AppError('Browser-originated requests are not accepted.', 403, 'FORBIDDEN_ORIGIN');
    c.set('requestCorrelation', c.get('requestId' as never) ?? crypto.randomUUID());
    await next();
  });
  // 4. bounded requests
  routes.use('*', async (c, next) => (deps.limiter ? deps.limiter(c as never, next) : rateLimit('AUTH_RATE_LIMITER', req => `stripe-read-admin:${req.headers.get('cf-connecting-ip') ?? 'unknown'}`)(c as never, next)));
  routes.use('*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: () => { throw new AppError('Request body is too large.', 422, 'BODY_TOO_LARGE'); } }));
  routes.use('*', async (c, next) => {
    if (c.req.method === 'POST') {
      const ct = c.req.header('content-type') ?? '';
      if (!/^application\/json(\s*;.*)?$/i.test(ct)) throw new AppError('Content-Type must be application/json.', 422, 'INVALID_REQUEST');
    }
    await next();
  });

  // 5. administrator session -> trusted context (the only place one is created for this API) and a request-scoped database
  routes.use('*', async (c, next) => {
    let handle: Awaited<ReturnType<AdminApiDeps['openDb']>>;
    try { handle = await deps.openDb(c.env); } catch { throw new AppError('Administrator authentication is unavailable.', 500, 'ADMIN_AUTH_UNAVAILABLE'); }
    try {
      const sessionDeps = deps.sessionDeps(handle.db, c.env, deps.clock);
      const result = await authenticateAdminSession(sessionDeps, c.req.header('authorization'));
      if (!result.ok) {
        const [status, code] = AUTH_FAILURE[result.reason];
        console.warn(JSON.stringify({ event: 'stripe_read_admin.denied', requestId: c.get('requestCorrelation'), reason: result.reason, status })); // no token, no session id
        throw new AppError(status === 401 ? 'Authentication required.' : status === 403 ? 'Administrator access denied.' : 'Administrator authentication is unavailable.', status, code);
      }
      c.set('adminCtx', result.context); c.set('db', handle.db); c.set('userId', result.context.adminUserId);
      await next();
    } finally { await handle.close().catch(() => undefined); }
  });

  const service = (c: Context<Env>) => {
    const db = c.get('db');
    return new ReadAuthorizationAdminService(db, deps.clock, createSessionRevalidator(deps.sessionDeps(db, c.env, deps.clock)));
  };
  const audit = (c: Context<Env>, action: string, authorizationId: string | null, businessId?: string) =>
    (c as never as { set(k: string, v: unknown): void }).set('auditMetadata', { action, entityType: 'stripe_read_authorization', ...(authorizationId ? { entityId: authorizationId } : {}), ...(businessId ? { businessId } : {}), details: { correlationId: c.get('requestCorrelation') } });
  const parse = async <T extends z.ZodType>(c: Context<Env>, schema: T): Promise<z.infer<T>> => {
    const body = await c.req.json().catch(() => null);
    const r = schema.safeParse(body);
    if (!r.success) throw new AppError('Invalid request body.', 422, 'INVALID_REQUEST', r.error.issues.map(i => ({ path: i.path.join('.'), code: i.code }))); // paths and codes only: never the submitted values
    return r.data;
  };
  const parseQuery = <T extends z.ZodType>(c: Context<Env>, schema: T): z.infer<T> => {
    const r = schema.safeParse(c.req.query());
    if (!r.success) throw new AppError('Invalid query.', 422, 'INVALID_REQUEST', r.error.issues.map(i => ({ path: i.path.join('.'), code: i.code })));
    return r.data;
  };
  const idParam = (c: Context<Env>) => { const r = UUID.safeParse(c.req.param('id')); if (!r.success) throw new AppError('Invalid authorization id.', 422, 'INVALID_REQUEST'); return r.data; };
  /** The approval policy as the database reports it. UNKNOWN (any failure) is treated as disabled by every caller. */
  const policyState = async (c: Context<Env>): Promise<'ENABLED' | 'DISABLED' | 'UNKNOWN'> => {
    try {
      const { sql } = await import('drizzle-orm');
      const rows = await c.get('db').transaction(async tx => { await tx.execute(sql`select set_config('role', 'stripe_read_auth_auditor', true)`); return (await tx.execute(sql`select approval_enabled from public.stripe_read_authorization_policy where singleton`)).rows as Array<{ approval_enabled: unknown }>; });
      if (rows.length !== 1) return 'UNKNOWN';
      return rows[0]!.approval_enabled === true ? 'ENABLED' : rows[0]!.approval_enabled === false ? 'DISABLED' : 'UNKNOWN';
    } catch { return 'UNKNOWN'; }
  };
  const scoped = async (c: Context<Env>, id: string, businessId: string) => {
    const status = await service(c).status(c.get('adminCtx'), id);
    if (!status || status.businessId !== businessId) throw notFound(); // a foreign or missing id looks the same
    return status;
  };

  // READ-ONLY policy status. There is deliberately no write handler for the policy anywhere in this module.
  routes.get('/policy', async c => {
    try {
      await service(c).assertLive(c.get('adminCtx')); // re-verifies the exact session at use time
      const state = await policyState(c);
      return ok(c, { approvalEnabled: state === 'ENABLED', state, mutableThroughApi: false });
    } catch (e) { return mapFailure(e); }
  });

  routes.post('/authorizations', async c => {
    try {
      const body = await parse(c, ProposalBody);
      if (body.expiresAtMs <= body.validFromMs) throw new AppError('Invalid validity interval.', 422, 'INVALID_REQUEST');
      if (body.expiresAtMs <= deps.clock()) throw new AppError('The authorization would already be expired.', 422, 'INVALID_REQUEST');
      if ((await policyState(c)) !== 'ENABLED') throw new AppError('The approval policy is disabled; no operational authorization can be proposed.', 409, 'APPROVAL_POLICY_DISABLED');
      const business = await createRepositories(c.get('db')).businesses.findById(body.businessId);
      if (!business || business.status !== 'active' || business.deletedAt) throw new AppError('Unknown business.', 404, 'NOT_FOUND');
      // the workload reference must be THE trusted verifier workload, for this account, method and test realm; with none provisioned the proposal is refused
      const env = (c.env.ENVIRONMENT ?? 'development') as WorkloadEnvironment;
      const resolved = await createWorkloadAuthority({ source: deps.workloadConfig, environment: env, clock: deps.clock }).resolve();
      if (!resolved.ok) throw new AppError('No trusted verifier workload is provisioned.', 409, 'WORKLOAD_NOT_PROVISIONED');
      const w = resolved.identity;
      if (body.workloadId !== w.workloadId || body.accountId !== w.accountId || body.realm !== w.realm || !(w.methods as readonly string[]).includes(body.methodId)) throw new AppError('The workload reference is not trusted.', 422, 'UNTRUSTED_WORKLOAD_REFERENCE');
      const id = await service(c).propose(c.get('adminCtx'), { businessId: body.businessId, accountId: body.accountId, workloadId: body.workloadId, methodId: body.methodId, validFromMs: body.validFromMs, expiresAtMs: body.expiresAtMs, inventoryRecordId: INVENTORY_RECORD_ID, inventoryRevision: body.inventoryRevision });
      audit(c, 'stripe_read_authorization.proposed', id, body.businessId);
      return ok(c, { authorizationId: id, state: 'PENDING', correlationId: c.get('requestCorrelation') }, 201);
    } catch (e) { return mapFailure(e); }
  });

  routes.post('/authorizations/:id/approve', async c => {
    try {
      const id = idParam(c); const body = await parse(c, ApprovalBody);
      const policy = await policyState(c);
      if (policy !== 'ENABLED') throw new AppError('The approval policy is disabled; no operational approval is possible.', 409, 'APPROVAL_POLICY_DISABLED');
      const version = await service(c).approve(c.get('adminCtx'), id, body.evidenceRef);
      audit(c, 'stripe_read_authorization.approved', id);
      return ok(c, { authorizationId: id, state: 'APPROVED', version, correlationId: c.get('requestCorrelation') });
    } catch (e) { return mapFailure(e); }
  });

  routes.post('/authorizations/:id/revoke', async c => {
    try {
      const id = idParam(c); const body = await parse(c, RevokeBody);
      const version = await service(c).revoke(c.get('adminCtx'), id, body.reason);
      audit(c, 'stripe_read_authorization.revoked', id);
      return ok(c, { authorizationId: id, state: 'REVOKED', version, correlationId: c.get('requestCorrelation') });
    } catch (e) { return mapFailure(e); }
  });

  routes.get('/authorizations/:id', async c => {
    try {
      const id = idParam(c); const { businessId } = parseQuery(c, ScopeQuery);
      const s = await scoped(c, id, businessId);
      const now = deps.clock();
      return ok(c, {
        authorizationId: s.authorizationId, businessId: s.businessId, accountId: s.accountId, workloadId: s.workloadId, methodId: s.methodId, version: s.version, validFromMs: s.validFromMs, expiresAtMs: s.expiresAtMs,
        state: s.state === 'APPROVED' && now >= s.expiresAtMs ? 'EXPIRED' : s.state, storedState: s.state, proposedByRef: await actorRef(s.proposedBy), approvedByRef: s.approvedBy ? await actorRef(s.approvedBy) : null,
        revokedByRef: s.revokedBy ? await actorRef(s.revokedBy) : null, correlationId: c.get('requestCorrelation'),
      });
    } catch (e) { return mapFailure(e); }
  });

  routes.get('/authorizations/:id/audit', async c => {
    try {
      const id = idParam(c); const q = parseQuery(c, AuditQuery);
      await scoped(c, id, q.businessId);
      const all = [...(await service(c).auditHistory(c.get('adminCtx'), id))].sort((a, b) => a.version - b.version); // deterministic order: the strictly increasing audit version
      const page = all.filter(e => e.version > q.afterVersion).slice(0, q.limit);
      const events = await Promise.all(page.map(async e => ({ version: e.version, eventType: e.eventType, fromState: e.fromState, toState: e.toState, actorRef: await actorRef(e.actorId), atMs: e.atMs, recordDigest: e.recordDigest })));
      const last = page[page.length - 1];
      return ok(c, { authorizationId: id, events, nextAfterVersion: last && all.some(e => e.version > last.version) ? last.version : null, limit: q.limit, correlationId: c.get('requestCorrelation') });
    } catch (e) { return mapFailure(e); }
  });

  return routes;
}

export const internalStripeReadAdminRoutes = createStripeReadAdminRoutes();
