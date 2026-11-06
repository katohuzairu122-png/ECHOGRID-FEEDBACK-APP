import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { AdminAuthorityError, requireFreshAdmin, type SessionRevalidator, type TrustedAdminContext } from './admin-session';
import { ReadAuthorizationLifecycle, ReadAuthorizationLifecycleError, type ProposalInput } from './durable-authorization';

/**
 * S08-D1D3-DEV-11: the administrator service over the DEV-10 durable lifecycle. INTERNAL: no route, queue or cron calls it, and the DEV-10 policy switch (`approval_enabled`) stays DISABLED by default, so a real
 * approval is refused by the database until the owner enables it out of band.
 *
 * Every operation takes a `TrustedAdminContext` and derives the actor from it. There is no actor parameter anywhere: a caller cannot name an administrator, and a forged, cloned or stale context is refused
 * before the database is touched. The database then enforces the lifecycle for every writer (administrator status, self-approval, terminal revocation, expiry, version, row locks, audit), so bypassing this
 * service gains nothing. Status and audit reads run as the auditor role and return identifiers, states, timestamps and digests only.
 */
export const DEFAULT_CONTEXT_MAX_AGE_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AUDITOR_ROLE = 'stripe_read_auth_auditor';

export interface AuthorizationStatus { readonly authorizationId: string; readonly businessId: string; readonly accountId: string; readonly workloadId: string; readonly methodId: string; readonly state: string; readonly version: number; readonly validFromMs: number; readonly expiresAtMs: number; readonly proposedBy: string; readonly approvedBy: string | null; readonly revokedBy: string | null }
export interface AuthorizationAuditEvent { readonly version: number; readonly eventType: string; readonly fromState: string | null; readonly toState: string; readonly actorId: string; readonly atMs: number; readonly recordDigest: string }

export class ReadAuthorizationAdminService {
  private readonly lifecycle: ReadAuthorizationLifecycle;
  /** `revalidate` is REQUIRED (DEV-11-R1): there is no way to build the service without a per-call session re-verification. */
  constructor(private readonly db: Database, private readonly clock: () => number, private readonly revalidate: SessionRevalidator, private readonly maxContextAgeMs: number = DEFAULT_CONTEXT_MAX_AGE_MS, lifecycle?: ReadAuthorizationLifecycle) {
    if (typeof revalidate !== 'function') throw new AdminAuthorityError('SESSION_NOT_LIVE');
    this.lifecycle = lifecycle ?? new ReadAuthorizationLifecycle(db);
  }
  /** The actor of every privileged call: derived from a genuine, fresh context whose exact session, token and administrator are re-verified against persisted state right now. */
  private async actor(ctx: TrustedAdminContext): Promise<string> {
    const id = requireFreshAdmin(ctx, this.clock(), this.maxContextAgeMs);
    if ((await this.revalidate(ctx)) !== 'LIVE') throw new AdminAuthorityError('SESSION_NOT_LIVE');
    return id;
  }
  /** Re-verifies the exact session and administrator right now, with no other effect. Used by read-only surfaces that touch no authorization row. */
  async assertLive(ctx: TrustedAdminContext): Promise<void> { await this.actor(ctx); }
  async propose(ctx: TrustedAdminContext, input: ProposalInput): Promise<string> { return this.lifecycle.propose(input, await this.actor(ctx)); }
  async approve(ctx: TrustedAdminContext, authorizationId: string, evidenceRef: string): Promise<number> { return this.lifecycle.approve(authorizationId, await this.actor(ctx), evidenceRef); }
  async revoke(ctx: TrustedAdminContext, authorizationId: string, reason: string): Promise<number> { return this.lifecycle.revoke(authorizationId, await this.actor(ctx), reason); }

  async status(ctx: TrustedAdminContext, authorizationId: string): Promise<AuthorizationStatus | null> {
    await this.actor(ctx);
    if (!UUID.test(authorizationId)) throw new ReadAuthorizationLifecycleError('INVALID_INPUT');
    const rows = await this.read(sql`select id, business_id, account_id, workload_id, method_id, state, version, valid_from_ms, expires_at_ms, proposed_by, approved_by, revoked_by from public.stripe_read_authorizations where id = ${authorizationId}::uuid`);
    const r = rows[0]; if (!r) return null;
    return { authorizationId: String(r.id), businessId: String(r.business_id), accountId: String(r.account_id), workloadId: String(r.workload_id), methodId: String(r.method_id), state: String(r.state), version: Number(r.version),
      validFromMs: Number(r.valid_from_ms), expiresAtMs: Number(r.expires_at_ms), proposedBy: String(r.proposed_by), approvedBy: r.approved_by === null ? null : String(r.approved_by), revokedBy: r.revoked_by === null ? null : String(r.revoked_by) };
  }
  async auditHistory(ctx: TrustedAdminContext, authorizationId: string): Promise<readonly AuthorizationAuditEvent[]> {
    await this.actor(ctx);
    if (!UUID.test(authorizationId)) throw new ReadAuthorizationLifecycleError('INVALID_INPUT');
    const rows = await this.read(sql`select version, event_type, from_state, to_state, actor_id, at_ms, record_digest from public.stripe_read_authorization_events where authorization_id = ${authorizationId}::uuid order by version`);
    return rows.map(r => ({ version: Number(r.version), eventType: String(r.event_type), fromState: r.from_state === null ? null : String(r.from_state), toState: String(r.to_state), actorId: String(r.actor_id), atMs: Number(r.at_ms), recordDigest: String(r.record_digest) }));
  }
  private async read(query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
    try {
      return await this.db.transaction(async tx => { await tx.execute(sql`select set_config('role', ${AUDITOR_ROLE}, true)`); return (await tx.execute(query)).rows as Array<Record<string, unknown>>; });
    } catch { throw new ReadAuthorizationLifecycleError('UNAVAILABLE'); }
  }
}
