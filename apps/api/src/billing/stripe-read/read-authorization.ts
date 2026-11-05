import { decideCapability, PERFORMABLE_METHODS, READ_METHODS, type ReadAuthorization, type ReadMethodId } from './capability-registry';

/**
 * S08-D1D3-DEV-09: durable, per-method READ AUTHORIZATION. This extends the DEV-06 capability registry (which stays the closed list of methods and the authority on realm, account, expiry and
 * method approval: `decideCapability` is reused below, not copied) with what a durable boundary needs: a record per method, bound to one business, one Stripe test account and one workload,
 * with a validity period, an approver and a revocation, read from a store the application does not write to.
 *
 * A record says "this workload may perform THIS read for THIS business against THIS account until THEN". It never says anything about field mappings, evidence or money, and it can never make a
 * method performable that the registry does not implement: the four unauthorized reads have no transport path, so no record can enable them. A caller cannot supply, replace or approve a record:
 * the only thing this module reads is the injected store, and the store interface has no write method (the in-memory administration object is a separate, development-only handle).
 */
export type ApprovalState = 'PENDING' | 'APPROVED' | 'REVOKED';
export interface ReadAuthorizationRecord {
  readonly authorizationId: string;
  readonly businessId: string;
  /** The approved Stripe TEST account (acct_*). */
  readonly accountId: string;
  readonly realm: 'test';
  /** Identity of the verifier workload that may use this authorization. */
  readonly workloadId: string;
  readonly methodId: ReadMethodId;
  readonly state: ApprovalState;
  /** Required when APPROVED: who approved. */
  readonly approvedBy: string | null;
  readonly validFromMs: number;
  readonly expiresAtMs: number;
  /** Present exactly when REVOKED. */
  readonly revokedAtMs: number | null;
  readonly inventoryRecordId: 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001';
  readonly inventoryRevision: string;
}

export type AuthorizationDenial =
  | 'UNKNOWN_METHOD' | 'METHOD_NOT_AUTHORIZED' | 'REALM_NOT_TEST' | 'INVALID_REQUEST' | 'AUTHORIZATION_STORE_UNAVAILABLE' | 'AUTHORIZATION_MALFORMED' | 'AUTHORIZATION_MISSING'
  | 'BUSINESS_MISMATCH' | 'ACCOUNT_MISMATCH' | 'WORKLOAD_MISMATCH' | 'AUTHORIZATION_NOT_APPROVED' | 'AUTHORIZATION_REVOKED' | 'AUTHORIZATION_EXPIRED' | 'AUTHORIZATION_NOT_YET_VALID'
  | 'ACCOUNT_NOT_APPROVED' | 'AUTHORIZATION_INVALID' | 'METHOD_NOT_APPROVED';
export type AuthorizationDecision = Readonly<{ allowed: true; record: ReadAuthorizationRecord }> | Readonly<{ allowed: false; reason: AuthorizationDenial }>;

/** The read-only view the enforcement code gets. There is deliberately no write method on it. */
export interface ReadAuthorizationStore {
  /** Records of this business for this method. A misbehaving store may return others; they are never trusted. */
  lookup(query: Readonly<{ businessId: string; methodId: ReadMethodId }>): Promise<readonly unknown[]>;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,159}$/;
const ACCOUNT = /^acct_[A-Za-z0-9]+$/;
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Strict parse of a stored record. Anything that is not exactly the contract (types, ranges, state/field consistency, unknown method) is null. */
export function parseAuthorizationRecord(raw: unknown): ReadAuthorizationRecord | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keys = ['authorizationId', 'businessId', 'accountId', 'realm', 'workloadId', 'methodId', 'state', 'approvedBy', 'validFromMs', 'expiresAtMs', 'revokedAtMs', 'inventoryRecordId', 'inventoryRevision'];
  if (Object.keys(r).length !== keys.length || !keys.every(k => has(r, k))) return null;
  if (![r.authorizationId, r.businessId, r.workloadId].every(x => typeof x === 'string' && TOKEN.test(x))) return null;
  if (typeof r.accountId !== 'string' || !ACCOUNT.test(r.accountId) || r.realm !== 'test') return null;
  if (typeof r.methodId !== 'string' || !has(READ_METHODS, r.methodId)) return null;
  if (r.state !== 'PENDING' && r.state !== 'APPROVED' && r.state !== 'REVOKED') return null;
  if (!isInt(r.validFromMs) || !isInt(r.expiresAtMs) || r.expiresAtMs <= r.validFromMs) return null;
  if (r.inventoryRecordId !== 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001' || typeof r.inventoryRevision !== 'string' || r.inventoryRevision.length === 0 || r.inventoryRevision.length > 160) return null;
  if (r.state === 'APPROVED' && !(typeof r.approvedBy === 'string' && TOKEN.test(r.approvedBy))) return null;
  if (r.state === 'PENDING' && r.approvedBy !== null) return null;
  if (r.approvedBy !== null && !(typeof r.approvedBy === 'string' && TOKEN.test(r.approvedBy))) return null;
  if (r.state === 'REVOKED' ? !isInt(r.revokedAtMs) : r.revokedAtMs !== null) return null;
  return Object.freeze({ ...(r as unknown as ReadAuthorizationRecord) });
}

/**
 * Decides whether this exact read may be performed NOW. Called immediately before every provider request. Every uncertainty is a denial; nothing is cached between calls, so a revocation takes
 * effect on the very next request.
 */
export async function authorizeRead(
  store: ReadAuthorizationStore,
  q: Readonly<{ businessId: string; accountId: string; workloadId: string; methodId: unknown; realm: unknown }>,
  nowMs: number,
): Promise<AuthorizationDecision> {
  const deny = (reason: AuthorizationDenial): AuthorizationDecision => ({ allowed: false, reason });
  if (!q || typeof q.businessId !== 'string' || !TOKEN.test(q.businessId) || typeof q.accountId !== 'string' || !ACCOUNT.test(q.accountId) || typeof q.workloadId !== 'string' || !TOKEN.test(q.workloadId) || !Number.isSafeInteger(nowMs)) return deny('INVALID_REQUEST');
  if (typeof q.methodId !== 'string' || !has(READ_METHODS, q.methodId)) return deny('UNKNOWN_METHOD');
  const methodId = q.methodId as ReadMethodId;
  // the registry is closed: a method without a transport path can never be authorized, whatever a store holds
  if (READ_METHODS[methodId].authorization === 'NOT_AUTHORIZED' || !PERFORMABLE_METHODS.includes(methodId)) return deny('METHOD_NOT_AUTHORIZED');
  if (q.realm !== 'test') return deny('REALM_NOT_TEST');

  let raw: readonly unknown[];
  try { raw = await store.lookup({ businessId: q.businessId, methodId }); } catch { return deny('AUTHORIZATION_STORE_UNAVAILABLE'); }
  if (!Array.isArray(raw)) return deny('AUTHORIZATION_MALFORMED');
  const records: ReadAuthorizationRecord[] = [];
  for (const x of raw) { const p = parseAuthorizationRecord(x); if (!p) return deny('AUTHORIZATION_MALFORMED'); records.push(p); } // one malformed record makes the whole answer untrustworthy
  const forMethod = records.filter(r => r.methodId === methodId);
  if (forMethod.length === 0) return deny('AUTHORIZATION_MISSING');
  if (forMethod.some(r => r.businessId !== q.businessId)) return deny('BUSINESS_MISMATCH');
  const forAccount = forMethod.filter(r => r.accountId === q.accountId);
  if (forAccount.length === 0) return deny('ACCOUNT_MISMATCH');
  const forWorkload = forAccount.filter(r => r.workloadId === q.workloadId);
  if (forWorkload.length === 0) return deny('WORKLOAD_MISMATCH');

  // among the matching records, the first one that is approved, unrevoked and inside its validity period (and that the registry accepts) authorizes the read
  let best: AuthorizationDenial = 'AUTHORIZATION_NOT_APPROVED';
  const rank: Record<string, number> = { AUTHORIZATION_NOT_APPROVED: 0, AUTHORIZATION_NOT_YET_VALID: 1, AUTHORIZATION_EXPIRED: 2, AUTHORIZATION_REVOKED: 3 };
  const consider = (d: AuthorizationDenial) => { if ((rank[d] ?? -1) > (rank[best] ?? -1)) best = d; };
  for (const r of forWorkload) {
    if (r.state === 'REVOKED') { consider('AUTHORIZATION_REVOKED'); continue; }
    if (r.state !== 'APPROVED') { consider('AUTHORIZATION_NOT_APPROVED'); continue; }
    if (nowMs < r.validFromMs) { consider('AUTHORIZATION_NOT_YET_VALID'); continue; }
    if (nowMs >= r.expiresAtMs) { consider('AUTHORIZATION_EXPIRED'); continue; }
    const legacy: ReadAuthorization = { approved: true, revoked: false, inventoryRecordId: r.inventoryRecordId, inventoryRevision: r.inventoryRevision, accountId: r.accountId, realm: r.realm, methods: [r.methodId], expiresAtMs: r.expiresAtMs };
    const d = decideCapability(methodId, legacy, nowMs);
    if (!d.allowed) return deny(d.reason as AuthorizationDenial);
    return { allowed: true, record: r };
  }
  return deny(best);
}

// ---- state machine ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type AuthorizationEvent = Readonly<{ type: 'APPROVE'; approvedBy: string }> | Readonly<{ type: 'REVOKE' }>;
export type TransitionResult = Readonly<{ ok: true; record: ReadAuthorizationRecord }> | Readonly<{ ok: false; reason: 'INVALID_TRANSITION' | 'APPROVER_REQUIRED' | 'RECORD_INVALID' | 'EXPIRED' }>;
/**
 * PENDING --APPROVE--> APPROVED --REVOKE--> REVOKED, and PENDING --REVOKE--> REVOKED. REVOKED is terminal (re-granting needs a NEW record). Expiry is not a stored transition: it is derived from the
 * validity period at every check. An approval needs a named approver and cannot be granted to an already expired record.
 */
export function transitionAuthorization(record: unknown, event: AuthorizationEvent, nowMs: number): TransitionResult {
  const r = parseAuthorizationRecord(record);
  if (!r || !Number.isSafeInteger(nowMs)) return { ok: false, reason: 'RECORD_INVALID' };
  if (event?.type === 'APPROVE') {
    if (r.state !== 'PENDING') return { ok: false, reason: 'INVALID_TRANSITION' };
    if (typeof event.approvedBy !== 'string' || !TOKEN.test(event.approvedBy)) return { ok: false, reason: 'APPROVER_REQUIRED' };
    if (nowMs >= r.expiresAtMs) return { ok: false, reason: 'EXPIRED' };
    return { ok: true, record: Object.freeze({ ...r, state: 'APPROVED' as const, approvedBy: event.approvedBy }) };
  }
  if (event?.type === 'REVOKE') {
    if (r.state === 'REVOKED') return { ok: false, reason: 'INVALID_TRANSITION' };
    return { ok: true, record: Object.freeze({ ...r, state: 'REVOKED' as const, revokedAtMs: nowMs }) };
  }
  return { ok: false, reason: 'INVALID_TRANSITION' };
}

/**
 * Development/test store. `store` is what enforcement receives (read-only, returns copies); `admin` is the separate handle an owner-side process would hold. New records can only be added as
 * PENDING; approval and revocation go through the state machine. Production storage and who may administer it are separate, owner-controlled decisions.
 */
export function createInMemoryAuthorizationStore() {
  const rows = new Map<string, ReadAuthorizationRecord>();
  const store: ReadAuthorizationStore = {
    async lookup(q) { return [...rows.values()].filter(r => r.businessId === q.businessId && r.methodId === q.methodId).map(r => JSON.parse(JSON.stringify(r)) as unknown); },
  };
  const admin = {
    add(raw: unknown): { ok: true } | { ok: false; reason: 'RECORD_INVALID' | 'NOT_PENDING' | 'DUPLICATE' } {
      const r = parseAuthorizationRecord(raw);
      if (!r) return { ok: false, reason: 'RECORD_INVALID' };
      if (r.state !== 'PENDING') return { ok: false, reason: 'NOT_PENDING' };
      if (rows.has(r.authorizationId)) return { ok: false, reason: 'DUPLICATE' };
      rows.set(r.authorizationId, r); return { ok: true };
    },
    apply(authorizationId: string, event: AuthorizationEvent, nowMs: number): TransitionResult {
      const cur = rows.get(authorizationId);
      if (!cur) return { ok: false, reason: 'RECORD_INVALID' };
      const t = transitionAuthorization(cur, event, nowMs);
      if (t.ok) rows.set(authorizationId, t.record);
      return t;
    },
  };
  return { store, admin };
}
/** A store that is down. Enforcement must treat it as a denial. */
export const unavailableAuthorizationStore: ReadAuthorizationStore = { async lookup() { throw new Error('authorization store unavailable'); } };
