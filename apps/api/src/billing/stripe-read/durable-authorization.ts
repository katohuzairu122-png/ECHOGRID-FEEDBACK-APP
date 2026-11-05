import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { READ_METHODS, type ReadMethodId } from './capability-registry';
import { unavailableAuthorizationStore, type ReadAuthorizationStore } from './read-authorization';

/**
 * S08-D1D3-DEV-10: the DURABLE read authorization store (migration 0062) and its internal lifecycle. DEVELOPMENT ONLY, inert.
 *
 *  - `createDurableAuthorizationStore` is what enforcement receives. It is read-only and has no write method. It runs one call of the verifier-scoped SECURITY DEFINER lookup function inside
 *    a transaction as the narrow `stripe_read_auth_verifier` role (the session must be a member of it), so a session that is not entitled gets a permission error, which is a DENIAL. Every
 *    failure (no database handle, a missing role or function, a network error, an unexpected row shape) is a denial: there is no fallback to the in-memory development store, and a missing
 *    database configuration yields the unavailable store.
 *  - `ReadAuthorizationLifecycle` proposes, approves and revokes through the administrator-only SECURITY DEFINER functions. It is an internal building block: no route, queue or cron uses it,
 *    and the database itself keeps approval DISABLED until the owner enables it (`stripe_read_authorization_policy`). The platform administrator it is given is checked by the database
 *    (active, `platform_role = 'admin'`, not deleted); the application layer that authenticates that administrator does not exist in this block.
 *  - Nothing here widens the capability registry: a row for a method the registry has no transport path for authorizes nothing.
 */
export const READ_AUTH_VERIFIER_ROLE = 'stripe_read_auth_verifier';
export const READ_AUTH_ADMIN_ROLE = 'stripe_read_auth_admin';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const ACCOUNT = /^acct_[A-Za-z0-9]{1,128}$/;
const WORKLOAD = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$/;
const PRINTABLE = /^[!-~]{1,255}$/;
const REASON = /^[A-Z_]{1,64}$/;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

const num = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : undefined);

/** Maps one database row to the record contract. A value that is not exactly what the table can hold becomes an invalid field, which the strict parser rejects. */
export function recordFromRow(r: Record<string, unknown>): unknown {
  const nullable = (v: unknown) => (v === null || v === undefined ? null : v);
  return {
    authorizationId: r.authorization_id, businessId: r.business_id, accountId: r.account_id, realm: r.realm, workloadId: r.workload_id, methodId: r.method_id, state: r.state,
    approvedBy: nullable(r.approved_by), validFromMs: num(r.valid_from_ms) ?? NaN, expiresAtMs: num(r.expires_at_ms) ?? NaN, revokedAtMs: r.revoked_at_ms === null || r.revoked_at_ms === undefined ? null : (num(r.revoked_at_ms) ?? NaN),
    version: num(r.version) ?? NaN, inventoryRecordId: r.inventory_record_id, inventoryRevision: r.inventory_revision,
  };
}

/**
 * The store enforcement uses. `db` undefined or null means "authorization is not configured": the store is down, every read is denied. The role is the verifier role the session switches to
 * for the one lookup; it is validated as a plain identifier.
 */
export function createDurableAuthorizationStore(db: Database | undefined | null, opts: Readonly<{ role?: string }> = {}): ReadAuthorizationStore {
  const role = opts.role ?? READ_AUTH_VERIFIER_ROLE;
  if (!db || typeof (db as { transaction?: unknown }).transaction !== 'function' || !ROLE_NAME.test(role)) return unavailableAuthorizationStore;
  return Object.freeze({
    async lookup(q: Readonly<{ businessId: string; methodId: ReadMethodId }>): Promise<readonly unknown[]> {
      if (typeof q?.businessId !== 'string' || !UUID.test(q.businessId) || typeof q.methodId !== 'string' || !has(READ_METHODS, q.methodId)) return []; // nothing can be stored for it: no record
      return db.transaction(async tx => {
        await tx.execute(sql`select set_config('role', ${role}, true)`);
        const res = await tx.execute(sql`select * from public.stripe_read_auth_lookup(${q.businessId}::uuid, ${q.methodId}::text)`);
        return (res.rows as Array<Record<string, unknown>>).map(recordFromRow);
      });
    },
  });
}

export type LifecycleCode =
  | 'INVALID_INPUT' | 'ADMIN_REQUIRED' | 'SELF_APPROVAL' | 'APPROVAL_DISABLED' | 'EXPIRED' | 'REVOKED_TERMINAL' | 'ALREADY_APPROVED' | 'NOT_FOUND' | 'INVALID_TRANSITION'
  | 'DUPLICATE_LIVE' | 'NOT_PERMITTED' | 'UNAVAILABLE';
export class ReadAuthorizationLifecycleError extends Error {
  constructor(readonly code: LifecycleCode) { super(`READ_AUTH_LIFECYCLE_${code}`); this.name = 'ReadAuthorizationLifecycleError'; }
}
const DB_CODES: Array<[string, LifecycleCode]> = [
  ['READ_AUTH_ADMIN_REQUIRED', 'ADMIN_REQUIRED'], ['READ_AUTH_SELF_APPROVAL', 'SELF_APPROVAL'], ['READ_AUTH_APPROVAL_DISABLED', 'APPROVAL_DISABLED'], ['READ_AUTH_EXPIRED', 'EXPIRED'],
  ['READ_AUTH_REVOKED_TERMINAL', 'REVOKED_TERMINAL'], ['READ_AUTH_ALREADY_APPROVED', 'ALREADY_APPROVED'], ['READ_AUTH_NOT_FOUND', 'NOT_FOUND'], ['READ_AUTH_INVALID_TRANSITION', 'INVALID_TRANSITION'],
  ['READ_AUTH_INSERT_NOT_PENDING', 'INVALID_TRANSITION'], ['READ_AUTH_IMMUTABLE', 'INVALID_TRANSITION'], ['READ_AUTH_VERSION', 'INVALID_TRANSITION'],
];
function mapDbError(e: unknown): ReadAuthorizationLifecycleError {
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string; constraint?: string } };
  const code = err?.cause?.code ?? err?.code; const message = String(err?.cause?.message ?? err?.message ?? '');
  if (code === '23505' && /stripe_read_auth_live_key/.test(String(err?.cause?.constraint ?? message))) return new ReadAuthorizationLifecycleError('DUPLICATE_LIVE');
  if (code === '42501' || code === '42883') return new ReadAuthorizationLifecycleError('NOT_PERMITTED');
  for (const [prefix, c] of DB_CODES) if (message.includes(prefix)) return new ReadAuthorizationLifecycleError(c);
  return new ReadAuthorizationLifecycleError('UNAVAILABLE'); // never echo database detail
}

export interface ProposalInput {
  readonly businessId: string; readonly accountId: string; readonly workloadId: string; readonly methodId: ReadMethodId;
  readonly validFromMs: number; readonly expiresAtMs: number; readonly inventoryRecordId: string; readonly inventoryRevision: string;
}

/** Internal lifecycle. Every call runs as the administrator role in its own transaction; the database enforces who may do what, this class only validates the shape of its input. */
export class ReadAuthorizationLifecycle {
  constructor(private readonly db: Database, private readonly role: string = READ_AUTH_ADMIN_ROLE) {
    if (!ROLE_NAME.test(role)) throw new ReadAuthorizationLifecycleError('INVALID_INPUT');
  }
  private async run<T>(fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(async tx => { await tx.execute(sql`select set_config('role', ${this.role}, true)`); return fn(tx); });
    } catch (e) { throw e instanceof ReadAuthorizationLifecycleError ? e : mapDbError(e); }
  }
  async propose(input: ProposalInput, actorId: string): Promise<string> {
    const i = input;
    if (!i || !UUID.test(i.businessId) || !UUID.test(actorId) || !ACCOUNT.test(i.accountId) || !WORKLOAD.test(i.workloadId) || typeof i.methodId !== 'string' || !has(READ_METHODS, i.methodId)
      || !Number.isSafeInteger(i.validFromMs) || !Number.isSafeInteger(i.expiresAtMs) || i.validFromMs < 0 || i.expiresAtMs <= i.validFromMs || !PRINTABLE.test(i.inventoryRecordId) || !PRINTABLE.test(i.inventoryRevision)) {
      throw new ReadAuthorizationLifecycleError('INVALID_INPUT');
    }
    return this.run(async tx => {
      const res = await tx.execute(sql`select public.stripe_read_auth_propose(${i.businessId}::uuid, ${i.accountId}::text, ${i.workloadId}::text, ${i.methodId}::text, ${i.validFromMs}::bigint, ${i.expiresAtMs}::bigint, ${actorId}::uuid, ${i.inventoryRecordId}::text, ${i.inventoryRevision}::text) as id`);
      return String((res.rows[0] as { id: string }).id);
    });
  }
  async approve(authorizationId: string, actorId: string, evidenceRef: string): Promise<number> {
    if (!UUID.test(authorizationId) || !UUID.test(actorId) || typeof evidenceRef !== 'string' || !PRINTABLE.test(evidenceRef)) throw new ReadAuthorizationLifecycleError('INVALID_INPUT');
    return this.run(async tx => Number(((await tx.execute(sql`select public.stripe_read_auth_approve(${authorizationId}::uuid, ${actorId}::uuid, ${evidenceRef}::text) as v`)).rows[0] as { v: number }).v));
  }
  async revoke(authorizationId: string, actorId: string, reason: string): Promise<number> {
    if (!UUID.test(authorizationId) || !UUID.test(actorId) || typeof reason !== 'string' || !REASON.test(reason)) throw new ReadAuthorizationLifecycleError('INVALID_INPUT');
    return this.run(async tx => Number(((await tx.execute(sql`select public.stripe_read_auth_revoke(${authorizationId}::uuid, ${actorId}::uuid, ${reason}::text) as v`)).rows[0] as { v: number }).v));
  }
}
