import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { AdminAuthorityError, requireFreshAdmin, type SessionRevalidator, type TrustedAdminContext } from './admin-session';
import { DEFAULT_CONTEXT_MAX_AGE_MS } from './read-authorization-admin';

/**
 * S08-D1D3-DEV-13: administration of the Stripe read-authorization POLICY. Requests to change the policy are durable (migration 0064), written against an expected policy version, and decided by a DISTINCT
 * platform administrator. Every operation takes a TrustedAdminContext (session-bound, DEV-11-R1) and re-verifies the exact session at use time; there is no actor parameter anywhere.
 *
 * APPROVING A REQUEST NEVER CHANGES THE POLICY. This service has no method that writes `approval_enabled`, the database has no function that applies a request to it, and the API has no route for it. The switch
 * stays owner-controlled and out of band (see policy-activation.ts for the sealed contract a future owner authority would have to satisfy). Reads of the policy fail closed: missing, inconsistent or unreadable is UNKNOWN,
 * which every caller treats as disabled.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JUSTIFICATION = /^[ -~]{1,255}$/;
const REF = /^[!-~]{1,255}$/;
const AUDITOR_ROLE = 'stripe_read_auth_auditor';
const ADMIN_ROLE = 'stripe_read_auth_admin';
export const MAX_POLICY_PAGE = 100;

export type PolicyChangeState = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';
export type PolicyDecision = 'APPROVE' | 'REJECT' | 'CANCEL';
export type PolicyStateName = 'ENABLED' | 'DISABLED' | 'UNKNOWN';
export interface PolicyStatus { readonly approvalEnabled: boolean; readonly version: number | null; readonly state: PolicyStateName }
export interface PolicyChange {
  readonly changeId: string; readonly seq: number; readonly expectedPolicyVersion: number; readonly targetState: boolean; readonly storedState: PolicyChangeState; readonly state: PolicyChangeState; readonly version: number;
  readonly justification: string; readonly proposedBy: string; readonly decidedBy: string | null; readonly decisionRef: string | null; readonly expiresAtMs: number; readonly decidedAtMs: number | null;
}
export interface PolicyAuditEvent { readonly seq: number; readonly version: number; readonly eventType: string; readonly fromState: string | null; readonly toState: string; readonly actorId: string | null; readonly decisionRef: string | null; readonly policyVersion: number; readonly atMs: number; readonly recordDigest: string }
export interface PolicyProposalInput { readonly targetState: boolean; readonly expectedVersion: number; readonly justification: string; readonly expiresAtMs: number }

export type PolicyAdminCode =
  | 'INVALID_INPUT' | 'ADMIN_REQUIRED' | 'SELF_DECISION' | 'VERSION_CONFLICT' | 'NO_CHANGE' | 'EXPIRED' | 'NOT_EXPIRED' | 'TERMINAL' | 'DECISION_CONFLICT' | 'NOT_FOUND' | 'POLICY_MISSING' | 'DUPLICATE_LIVE' | 'NOT_PERMITTED' | 'UNAVAILABLE' | 'INVALID_TRANSITION';
export class PolicyAdministrationError extends Error { constructor(readonly code: PolicyAdminCode) { super(`POLICY_ADMIN_${code}`); this.name = 'PolicyAdministrationError'; } }
const DB_CODES: Array<[string, PolicyAdminCode]> = [
  ['READ_POLICY_ADMIN_REQUIRED', 'ADMIN_REQUIRED'], ['READ_POLICY_SELF_DECISION', 'SELF_DECISION'], ['READ_POLICY_VERSION_CONFLICT', 'VERSION_CONFLICT'], ['READ_POLICY_NO_CHANGE', 'NO_CHANGE'],
  ['READ_POLICY_NOT_EXPIRED', 'NOT_EXPIRED'], ['READ_POLICY_EXPIRED', 'EXPIRED'], ['READ_POLICY_TERMINAL', 'TERMINAL'], ['READ_POLICY_DECISION_CONFLICT', 'DECISION_CONFLICT'], ['READ_POLICY_NOT_FOUND', 'NOT_FOUND'],
  ['READ_POLICY_MISSING', 'POLICY_MISSING'], ['READ_POLICY_INVALID_TRANSITION', 'INVALID_TRANSITION'], ['READ_POLICY_INSERT_NOT_PENDING', 'INVALID_TRANSITION'], ['READ_POLICY_IMMUTABLE', 'INVALID_TRANSITION'], ['READ_POLICY_VERSION:', 'INVALID_TRANSITION'],
];
function mapDbError(e: unknown): PolicyAdministrationError {
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string; constraint?: string } };
  const code = err?.cause?.code ?? err?.code; const message = String(err?.cause?.message ?? err?.message ?? '');
  if (code === '23505' && /stripe_read_policy_change_live_key/.test(String(err?.cause?.constraint ?? message))) return new PolicyAdministrationError('DUPLICATE_LIVE');
  if (code === '42501' || code === '42883') return new PolicyAdministrationError('NOT_PERMITTED');
  for (const [prefix, c] of DB_CODES) if (message.includes(prefix)) return new PolicyAdministrationError(c);
  return new PolicyAdministrationError('UNAVAILABLE'); // never echo database detail
}
const num = (v: unknown): number | null => (v === null || v === undefined ? null : typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : NaN);

export class PolicyAdministrationService {
  constructor(private readonly db: Database, private readonly clock: () => number, private readonly revalidate: SessionRevalidator, private readonly maxContextAgeMs: number = DEFAULT_CONTEXT_MAX_AGE_MS) {
    if (typeof revalidate !== 'function') throw new AdminAuthorityError('SESSION_NOT_LIVE');
  }
  /** The actor of every call: a genuine, fresh context whose exact session, token and administrator are re-verified against persisted state right now. */
  private async actor(ctx: TrustedAdminContext): Promise<string> {
    const id = requireFreshAdmin(ctx, this.clock(), this.maxContextAgeMs);
    if ((await this.revalidate(ctx)) !== 'LIVE') throw new AdminAuthorityError('SESSION_NOT_LIVE');
    return id;
  }
  private async as<T>(role: string, fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>): Promise<T> {
    try { return await this.db.transaction(async tx => { await tx.execute(sql`select set_config('role', ${role}, true)`); return fn(tx); }); }
    catch (e) { throw e instanceof PolicyAdministrationError || e instanceof AdminAuthorityError ? e : mapDbError(e); }
  }

  /** Current policy as the database reports it. Missing, duplicated, inconsistent or unreadable is UNKNOWN (disabled). */
  async status(ctx: TrustedAdminContext): Promise<PolicyStatus> {
    await this.actor(ctx);
    try {
      const rows = await this.as(AUDITOR_ROLE, async tx => (await tx.execute(sql`select approval_enabled, version from public.stripe_read_authorization_policy`)).rows as Array<{ approval_enabled: unknown; version: unknown }>);
      const v = rows.length === 1 ? num(rows[0]!.version) : null; const e = rows.length === 1 ? rows[0]!.approval_enabled : null;
      if (typeof e !== 'boolean' || v === null || !Number.isSafeInteger(v) || v < 1) return { approvalEnabled: false, version: null, state: 'UNKNOWN' };
      return { approvalEnabled: e, version: v, state: e ? 'ENABLED' : 'DISABLED' };
    } catch (e) { if (e instanceof AdminAuthorityError) throw e; return { approvalEnabled: false, version: null, state: 'UNKNOWN' }; }
  }

  async propose(ctx: TrustedAdminContext, input: PolicyProposalInput): Promise<string> {
    const actor = await this.actor(ctx);
    if (!input || typeof input.targetState !== 'boolean' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || typeof input.justification !== 'string' || !JUSTIFICATION.test(input.justification) || !Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= 0) throw new PolicyAdministrationError('INVALID_INPUT');
    return this.as(ADMIN_ROLE, async tx => String(((await tx.execute(sql`select public.stripe_read_policy_propose(${actor}::uuid, ${input.targetState}::boolean, ${input.expectedVersion}::integer, ${input.justification}::text, ${input.expiresAtMs}::bigint) as id`)).rows[0] as { id: string }).id));
  }
  async decide(ctx: TrustedAdminContext, changeId: string, decision: PolicyDecision, decisionRef: string): Promise<number> {
    const actor = await this.actor(ctx);
    if (!UUID.test(changeId) || (decision !== 'APPROVE' && decision !== 'REJECT' && decision !== 'CANCEL') || typeof decisionRef !== 'string' || !REF.test(decisionRef)) throw new PolicyAdministrationError('INVALID_INPUT');
    return this.as(ADMIN_ROLE, async tx => Number(((await tx.execute(sql`select public.stripe_read_policy_decide(${changeId}::uuid, ${actor}::uuid, ${decision}::text, ${decisionRef}::text) as v`)).rows[0] as { v: number }).v));
  }
  async expire(ctx: TrustedAdminContext, changeId: string): Promise<number> {
    const actor = await this.actor(ctx);
    if (!UUID.test(changeId)) throw new PolicyAdministrationError('INVALID_INPUT');
    return this.as(ADMIN_ROLE, async tx => Number(((await tx.execute(sql`select public.stripe_read_policy_expire(${changeId}::uuid, ${actor}::uuid) as v`)).rows[0] as { v: number }).v));
  }

  private toChange(r: Record<string, unknown>): PolicyChange {
    const stored = String(r.state) as PolicyChangeState; const expiresAtMs = Number(r.expires_at_ms);
    return {
      changeId: String(r.id), seq: Number(r.seq), expectedPolicyVersion: Number(r.expected_policy_version), targetState: r.target_state === true, storedState: stored, state: stored === 'PENDING' && this.clock() >= expiresAtMs ? 'EXPIRED' : stored,
      version: Number(r.version), justification: String(r.justification), proposedBy: String(r.proposed_by), decidedBy: r.decided_by === null ? null : String(r.decided_by), decisionRef: r.decision_ref === null ? null : String(r.decision_ref),
      expiresAtMs, decidedAtMs: num(r.decided_at_ms),
    };
  }
  async get(ctx: TrustedAdminContext, changeId: string): Promise<PolicyChange | null> {
    await this.actor(ctx);
    if (!UUID.test(changeId)) throw new PolicyAdministrationError('INVALID_INPUT');
    const rows = await this.as(AUDITOR_ROLE, async tx => (await tx.execute(sql`select * from public.stripe_read_policy_changes where id = ${changeId}::uuid`)).rows as Array<Record<string, unknown>>);
    return rows[0] ? this.toChange(rows[0]) : null;
  }
  /** Requests still PENDING (and not yet past their expiry), oldest first by the database sequence; bounded pages. */
  async listPending(ctx: TrustedAdminContext, opts: { limit: number; afterSeq: number }): Promise<{ items: PolicyChange[]; nextAfterSeq: number | null }> {
    await this.actor(ctx);
    if (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > MAX_POLICY_PAGE || !Number.isSafeInteger(opts.afterSeq) || opts.afterSeq < 0) throw new PolicyAdministrationError('INVALID_INPUT');
    const now = this.clock();
    const rows = await this.as(AUDITOR_ROLE, async tx => (await tx.execute(sql`select * from public.stripe_read_policy_changes where state = 'PENDING' and expires_at_ms > ${now}::bigint and seq > ${opts.afterSeq}::bigint order by seq limit ${opts.limit + 1}::integer`)).rows as Array<Record<string, unknown>>);
    const page = rows.slice(0, opts.limit).map(r => this.toChange(r));
    return { items: page, nextAfterSeq: rows.length > opts.limit ? page[page.length - 1]!.seq : null };
  }
  async audit(ctx: TrustedAdminContext, changeId: string, opts: { limit: number; afterSeq: number }): Promise<{ events: PolicyAuditEvent[]; nextAfterSeq: number | null }> {
    await this.actor(ctx);
    if (!UUID.test(changeId) || !Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > MAX_POLICY_PAGE || !Number.isSafeInteger(opts.afterSeq) || opts.afterSeq < 0) throw new PolicyAdministrationError('INVALID_INPUT');
    const rows = await this.as(AUDITOR_ROLE, async tx => (await tx.execute(sql`select * from public.stripe_read_policy_events where change_id = ${changeId}::uuid and seq > ${opts.afterSeq}::bigint order by seq limit ${opts.limit + 1}::integer`)).rows as Array<Record<string, unknown>>);
    const events = rows.slice(0, opts.limit).map(r => ({ seq: Number(r.seq), version: Number(r.version), eventType: String(r.event_type), fromState: r.from_state === null ? null : String(r.from_state), toState: String(r.to_state), actorId: r.actor_id === null ? null : String(r.actor_id), decisionRef: r.decision_ref === null ? null : String(r.decision_ref), policyVersion: Number(r.policy_version), atMs: Number(r.at_ms), recordDigest: String(r.record_digest) }));
    return { events, nextAfterSeq: rows.length > opts.limit ? events[events.length - 1]!.seq : null };
  }
  /** Out-of-band and owner-made changes to the policy ROW itself (not request transitions), newest last: the audit trail of the switch. */
  async policyRowHistory(ctx: TrustedAdminContext, opts: { limit: number; afterSeq: number }): Promise<{ events: Array<{ seq: number; eventType: string; fromState: string | null; toState: string; policyVersion: number; atMs: number; recordDigest: string }>; nextAfterSeq: number | null }> {
    await this.actor(ctx);
    if (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > MAX_POLICY_PAGE || !Number.isSafeInteger(opts.afterSeq) || opts.afterSeq < 0) throw new PolicyAdministrationError('INVALID_INPUT');
    const rows = await this.as(AUDITOR_ROLE, async tx => (await tx.execute(sql`select * from public.stripe_read_policy_events where change_id is null and seq > ${opts.afterSeq}::bigint order by seq limit ${opts.limit + 1}::integer`)).rows as Array<Record<string, unknown>>);
    const events = rows.slice(0, opts.limit).map(r => ({ seq: Number(r.seq), eventType: String(r.event_type), fromState: r.from_state === null ? null : String(r.from_state), toState: String(r.to_state), policyVersion: Number(r.policy_version), atMs: Number(r.at_ms), recordDigest: String(r.record_digest) }));
    return { events, nextAfterSeq: rows.length > opts.limit ? events[events.length - 1]!.seq : null };
  }
}
