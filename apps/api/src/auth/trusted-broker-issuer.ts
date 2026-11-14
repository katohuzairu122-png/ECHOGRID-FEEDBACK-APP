import { sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/client';
import { createRepositories } from '../repositories';
import { AuthorizationService } from '../rbac/authorization.service';
import { assertBusinessIsUsable } from '../rbac/business-access';
import { verifyAccessToken } from './jwt';
import { BROKER_AUDIENCE, BROKER_ISSUER, BROKER_WORKLOAD, BROKER_UUID, brokerAssertionMessage, brokerHex,
  validBrokerKey, verifyBrokerAssertionSignature, type BrokerAssertion, type BrokerAssertionClaims, type BrokerKeySource } from './broker-assertion.contract';

export interface BrokerIssueRequest { readonly authorization: string; readonly businessId: string; readonly branchId: string; readonly operation: 'branches:read' }
export type BrokerIssueResult = Readonly<{ ok: true; assertion: BrokerAssertion; brokerAuthorization: 'NOT_GRANTED' }> |
  Readonly<{ ok: false; reason: 'REQUEST_INVALID' | 'AUTHENTICATION_DENIED' | 'AUTHORIZATION_DENIED' | 'ISSUER_UNAVAILABLE'; brokerAuthorization: 'NOT_GRANTED' }>;
const deny = (reason: Extract<BrokerIssueResult, { ok: false }>['reason']): BrokerIssueResult => ({ ok: false, reason, brokerAuthorization: 'NOT_GRANTED' });
const now = async (tx: Transaction): Promise<number> => Number((await tx.execute(sql`select floor(extract(epoch from clock_timestamp()))::bigint n`)).rows[0]!.n);

/** Development-only, NOT wired to routes or Hyperdrive. The trusted composition
 * root supplies a separate authorization DB connection and signer capability.
 * No API accepts caller-selected actor/session, private key, verdict or nonce.
 * PostgreSQL broker verification and use-time revocation remain separately blocked.
 */
export class TrustedBrokerAssertionIssuer {
  constructor(private readonly deps: Readonly<{ db: Database; accessSecret: string; keys: BrokerKeySource;
    signer: { readonly keyId: string; sign(message: Uint8Array): Promise<Uint8Array> } }>) {}

  async issue(request: BrokerIssueRequest): Promise<BrokerIssueResult> {
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).sort().join(',') !== 'authorization,branchId,businessId,operation' ||
        request.operation !== 'branches:read' || typeof request.businessId !== 'string' || typeof request.branchId !== 'string' || !BROKER_UUID.test(request.businessId) || !BROKER_UUID.test(request.branchId) ||
        typeof request.authorization !== 'string' || !/^Bearer \S{1,4096}$/.test(request.authorization)) return deny('REQUEST_INVALID');
      const r = Object.freeze({ ...request });
      let token;
      try { token = await verifyAccessToken(r.authorization.slice(7), this.deps.accessSecret); }
      catch { return deny('AUTHENTICATION_DENIED'); }
      if (!token.sid || !BROKER_UUID.test(token.sid) || !BROKER_UUID.test(token.sub) || token.impersonatedBy !== undefined || (token as { client?: unknown }).client !== undefined ||
        !Number.isSafeInteger(token.exp) || !Number.isSafeInteger(token.iat) || token.exp <= token.iat) return deny('AUTHENTICATION_DENIED');
      const actorId = token.sub; const sessionId = token.sid;
      return await this.deps.db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '5s'`);
        // Fixed lock order: user, exact-session rows, business, branch, grants /
        // role / permission rows. Existing UPDATE/DELETE revocations conflict
        // with SHARE locks. No session settings carry tenant authorization.
        await tx.execute(sql`select id from users where id=${actorId}::uuid for share`);
        await tx.execute(sql`select id from refresh_tokens where user_id=${actorId}::uuid and session_id=${sessionId}::uuid order by id for share`);
        const repos = createRepositories(tx);
        const user = await repos.users.findById(actorId);
        let t = await now(tx);
        if (!user || user.status !== 'active' || user.isDeleted || user.deletedAt || token.exp <= t || token.iat > t ||
          !(await repos.refreshTokens.isSessionLive(actorId, sessionId, t * 1000))) return deny('AUTHENTICATION_DENIED');
        const authz = new AuthorizationService(repos);
        if ((await authz.getMembership(actorId, r.businessId)).length === 0) return deny('AUTHORIZATION_DENIED');
        await tx.execute(sql`select id from businesses where id=${r.businessId}::uuid for share`);
        try { assertBusinessIsUsable(await repos.businesses.findById(r.businessId)); } catch { return deny('AUTHORIZATION_DENIED'); }
        await tx.execute(sql`select id from branches where id=${r.branchId}::uuid and business_id=${r.businessId}::uuid for share`);
        if (!(await repos.branches.findById(r.branchId, r.businessId))) return deny('AUTHORIZATION_DENIED');
        // Pin the actual permission-bearing grant chain, not a stale permission cache.
        const grant = await tx.execute(sql`select g.id from user_business_roles g join roles r on r.id=g.role_id
          join role_permissions rp on rp.role_id=r.id join permissions p on p.id=rp.permission_id
          where g.user_id=${actorId}::uuid and g.business_id=${r.businessId}::uuid and r.business_id=g.business_id
          and (g.branch_id is null or g.branch_id=${r.branchId}::uuid) and g.deleted_at is null and not r.is_deleted
          and p.key='branches:view' order by g.id for share of g,r,rp,p`);
        if (grant.rows.length === 0 || !(await authz.getEffectivePermissions(actorId, r.businessId, r.branchId)).has('branches:view')) return deny('AUTHORIZATION_DENIED');
        const key = await this.deps.keys(); t = await now(tx);
        if (!validBrokerKey(key, t) || key.keyId !== this.deps.signer.keyId) return deny('ISSUER_UNAVAILABLE');
        const claims: BrokerAssertionClaims = Object.freeze({ version: 'B4-03/1', algorithm: 'Ed25519', environment: 'development',
          issuer: BROKER_ISSUER, audience: BROKER_AUDIENCE, workloadId: BROKER_WORKLOAD, keyId: key.keyId, keyVersion: key.version,
          actorType: 'staff', actorId, sessionId, businessId: r.businessId, branchId: r.branchId, operation: 'branches:read', permission: 'branches:view',
          requestId: crypto.randomUUID(), nonce: crypto.randomUUID(), issuedAt: t, expiresAt: Math.min(t + 60, token.exp, key.notAfter), authorizationVersion: null });
        const assertion = Object.freeze({ claims, signature: brokerHex(await this.deps.signer.sign(brokerAssertionMessage(claims))) });
        t = await now(tx);
        // Expiry and signer/key status can change during external signer latency.
        if (token.exp <= t || !(await repos.refreshTokens.isSessionLive(actorId, sessionId, t * 1000))) return deny('AUTHENTICATION_DENIED');
        if (!(await verifyBrokerAssertionSignature(assertion, this.deps.keys, t))) return deny('ISSUER_UNAVAILABLE');
        return Object.freeze({ ok: true, assertion, brokerAuthorization: 'NOT_GRANTED' });
      });
    } catch { return deny('ISSUER_UNAVAILABLE'); }
  }
}
