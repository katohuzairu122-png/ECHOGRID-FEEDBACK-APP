import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { canonicalJson } from './bundle-builder';
import { PURPOSE_EVIDENCE_TYPES, type EvidenceKeyDirectory, type EvidenceSigningPurpose } from './evidence-signing-keys';
import { SIGNING_BUSINESS_ID, type SigningWorkloadAuthority, type SigningWorkloadDenial } from './evidence-signing-workload';
import { cleanPayload, createEvidenceVerifier, type EvidenceClaims, type EvidenceDenial, type SignedEvidence } from './evidence-signing';
import type { WorkloadEnvironment } from './workload-identity';

/**
 * S08-D1D3-DEV-15: TRUSTED PERSISTENCE AND RETRIEVAL of DEV-14 signed evidence (migration 0065).
 *
 * AUTHENTICITY CUSTODY ONLY. Nothing here grants financial authorization: every success carries the constant `financialAuthorization: 'NOT_GRANTED'`, the module imports no settlement, consumption, ledger, policy or
 * Stripe code, and it has no route (it is an internal service for an authorized custodian workload).
 *
 *  - PERSIST: the calling workload is resolved from TRUSTED configuration with the EVIDENCE_CUSTODIAN role (a signer cannot persist; no identity parameter exists). The caller states the binding it EXPECTS
 *    (business, purpose, evidence type); the environment is the service's own. The DEV-14 verifier then checks the whole envelope (signature, key lifecycle policy, bindings, payload hash) BEFORE storage; a caller-supplied
 *    "verified" flag does not exist. The stored columns come from the VERIFIED claims, the payload is stored as the exact canonical text that was hashed, and the signature is never regenerated. The database function
 *    is idempotent (identical content replays), refuses any conflicting content, and writes the PERSISTED custody event in the same transaction, so a failing audit insert leaves no record.
 *  - RETRIEVE: the tenant is an explicit argument to a definer function (never a session variable); the stored row's own digest is recomputed, then the envelope is RE-VERIFIED against the current key directory
 *    (a database digest or RLS policy is not proof of provider authenticity). The verification outcome is recorded as a custody event before the evidence is returned; if it cannot be recorded, nothing is returned.
 *  - Authority denials (unknown, expired, revoked, wrong-role or wrong-tenant workloads) never reach the database, so they cannot leave a custody event; they go to a separate bounded security-log channel with fixed
 *    fields only (no payload, no key material). That is the documented limitation of not letting an unauthorized caller write to the store merely to leave a record.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WRITER_ROLE = 'signed_evidence_writer';
const READER_ROLE = 'signed_evidence_reader';
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export type CustodyDenial = SigningWorkloadDenial | EvidenceDenial | 'INVALID_REQUEST' | 'PAYLOAD_REJECTED' | 'EVIDENCE_CONFLICT' | 'NOT_FOUND' | 'CUSTODY_RECORD_INCONSISTENT' | 'BUSINESS_UNKNOWN' | 'STORE_NOT_PERMITTED' | 'STORE_UNAVAILABLE';
export interface ExpectedBinding { readonly businessId: string; readonly purpose: EvidenceSigningPurpose; readonly evidenceType: string }
export interface PersistRequest { readonly evidenceId: string; readonly expected: ExpectedBinding; readonly evidence: SignedEvidence }
export interface RetrieveRequest extends ExpectedBinding { readonly evidenceId: string }
export type PersistResult =
  | Readonly<{ ok: true; evidenceId: string; outcome: 'PERSISTED' | 'REPLAYED'; financialAuthorization: 'NOT_GRANTED'; metadata: Readonly<{ keyId: string; keyVersion: number; algorithm: string; environment: WorkloadEnvironment; payloadSha256: string }> }>
  | Readonly<{ ok: false; reason: CustodyDenial }>;
export interface CustodyStatus { readonly status: 'STORED'; readonly recordVersion: number; readonly persistedAtMs: number; readonly custodianWorkloadId: string }
export type RetrieveResult =
  | Readonly<{ ok: true; evidenceId: string; authenticity: 'AUTHENTIC'; financialAuthorization: 'NOT_GRANTED'; claims: EvidenceClaims; payload: Readonly<Record<string, unknown>>; keyState: 'ACTIVE' | 'RETIRED'; custody: CustodyStatus }>
  | Readonly<{ ok: false; reason: CustodyDenial }>;
/** Bounded security-log channel for denials that must not touch the store. Fixed fields only. */
export interface SecurityLogEntry { readonly event: 'signed_evidence.denied'; readonly operation: 'persist' | 'retrieve'; readonly reason: string; readonly businessId: string | null; readonly evidenceId: string | null }

/** The canonical content digest: byte-length-prefixed fields, identical to `public.evidence_custody_content_digest`. */
export async function contentDigest(f: Readonly<{ businessId: string; signerWorkloadId: string; environment: string; purpose: string; evidenceType: string; schema: string; schemaVersion: number; signedAtMs: number; keyId: string; keyVersion: number; algorithm: string; payloadSha256: string; signature: string; payloadCanonical: string }>): Promise<string> {
  const parts = ['S08/SIGNED-EVIDENCE-CUSTODY/1', f.businessId, f.signerWorkloadId, f.environment, f.purpose, f.evidenceType, f.schema, String(f.schemaVersion), String(f.signedAtMs), f.keyId, String(f.keyVersion), f.algorithm, f.payloadSha256, f.signature, f.payloadCanonical];
  const text = parts.map(v => `${new TextEncoder().encode(v).length}:${v};`).join('');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
}

function mapDbError(e: unknown): CustodyDenial {
  const err = e as { code?: string; cause?: { code?: string } };
  const code = err?.cause?.code ?? err?.code;
  if (code === '42501' || code === '42883') return 'STORE_NOT_PERMITTED';
  if (code === '23503') return 'BUSINESS_UNKNOWN';
  if (code === '23514') return 'INVALID_REQUEST';
  return 'STORE_UNAVAILABLE'; // never echo database detail
}
const validExpected = (x: unknown): x is ExpectedBinding => {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const e = x as Record<string, unknown>;
  return Object.keys(e).length === 3 && ['businessId', 'purpose', 'evidenceType'].every(k => has(e, k)) && typeof e.businessId === 'string' && SIGNING_BUSINESS_ID.test(e.businessId)
    && typeof e.purpose === 'string' && has(PURPOSE_EVIDENCE_TYPES, e.purpose) && typeof e.evidenceType === 'string' && PURPOSE_EVIDENCE_TYPES[e.purpose as EvidenceSigningPurpose].includes(e.evidenceType);
};

export interface CustodyDeps {
  readonly db: Database;
  /** Authority for the EVIDENCE_CUSTODIAN role (createSigningWorkloadAuthority({ role: 'EVIDENCE_CUSTODIAN', ... })). */
  readonly authority: SigningWorkloadAuthority;
  readonly keys: EvidenceKeyDirectory;
  readonly policy?: unknown;
  readonly environment: WorkloadEnvironment;
  readonly clock: () => number;
  readonly securityLog?: (e: SecurityLogEntry) => void;
}

export class SignedEvidenceCustodyService {
  private readonly verifier;
  constructor(private readonly d: CustodyDeps) {
    this.verifier = createEvidenceVerifier({ keys: d.keys, policy: d.policy, clock: d.clock });
  }
  private log(operation: 'persist' | 'retrieve', reason: string, businessId: string | null, evidenceId: string | null): void {
    try { (this.d.securityLog ?? ((e: SecurityLogEntry) => console.warn(JSON.stringify(e))))({ event: 'signed_evidence.denied', operation, reason, businessId, evidenceId }); } catch { /* logging never changes the outcome */ }
  }
  private async as<T>(role: string, fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>): Promise<T> {
    return this.d.db.transaction(async tx => { await tx.execute(sql`select set_config('role', ${role}, true)`); return fn(tx); });
  }
  private async authorize(op: 'persist' | 'retrieve', b: ExpectedBinding, evidenceId: string): Promise<{ workloadId: string } | CustodyDenial> {
    const who = await this.d.authority.resolve();
    if (!who.ok) { this.log(op, who.reason, b.businessId, evidenceId); return who.reason; }
    const denied = await this.d.authority.check(who.identity, { environment: this.d.environment, purpose: b.purpose, evidenceType: b.evidenceType, businessId: b.businessId });
    if (denied) { this.log(op, denied, b.businessId, evidenceId); return denied; }
    return { workloadId: who.identity.workloadId };
  }

  async persist(request: PersistRequest): Promise<PersistResult> {
    const r = request as unknown as Record<string, unknown>;
    if (r === null || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).length !== 3 || !['evidenceId', 'expected', 'evidence'].every(k => has(r, k))
      || typeof r.evidenceId !== 'string' || !UUID.test(r.evidenceId) || !validExpected(r.expected)) return { ok: false, reason: 'INVALID_REQUEST' };
    const expected = r.expected as ExpectedBinding; const evidenceId = r.evidenceId as string;
    const auth = await this.authorize('persist', expected, evidenceId);
    if (typeof auth === 'string') return { ok: false, reason: auth };

    // verification happens BEFORE storage, by the DEV-14 verifier, against the trusted key directory
    const v = await this.verifier.verify(r.evidence, { ...expected, environment: this.d.environment });
    if (!v.ok) return { ok: false, reason: v.reason };
    // a genuine signature over a verdict-bearing payload is still not storable as evidence: custody never carries a financial decision
    if (!cleanPayload(v.payload)) return { ok: false, reason: 'PAYLOAD_REJECTED' };
    const c = v.claims; const payloadCanonical = canonicalJson(v.payload);
    try {
      const outcome = await this.as(WRITER_ROLE, async tx => String(((await tx.execute(sql`select public.evidence_custody_persist(${evidenceId}::uuid, ${auth.workloadId}::text, ${c.businessId}::uuid, ${c.workloadId}::text, ${c.environment}::text, ${c.purpose}::text, ${c.evidenceType}::text,
        ${c.schema}::text, ${c.schemaVersion}::integer, ${c.signedAtMs}::bigint, ${c.keyId}::text, ${c.keyVersion}::integer, ${c.algorithm}::text, ${c.payloadSha256}::text, ${(r.evidence as SignedEvidence).signature}::text, ${payloadCanonical}::text) as v`)).rows[0] as { v: unknown }).v));
      if (outcome === 'CONFLICT') return { ok: false, reason: 'EVIDENCE_CONFLICT' };
      if (outcome !== 'PERSISTED' && outcome !== 'REPLAYED') return { ok: false, reason: 'STORE_UNAVAILABLE' };
      return { ok: true, evidenceId, outcome, financialAuthorization: 'NOT_GRANTED', metadata: Object.freeze({ keyId: c.keyId, keyVersion: c.keyVersion, algorithm: c.algorithm, environment: c.environment, payloadSha256: c.payloadSha256 }) };
    } catch (e) { return { ok: false, reason: mapDbError(e) }; }
  }

  async retrieve(request: RetrieveRequest): Promise<RetrieveResult> {
    const r = request as unknown as Record<string, unknown>;
    if (r === null || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).length !== 4 || !has(r, 'evidenceId') || typeof r.evidenceId !== 'string' || !UUID.test(r.evidenceId)
      || !validExpected({ businessId: r.businessId, purpose: r.purpose, evidenceType: r.evidenceType })) return { ok: false, reason: 'INVALID_REQUEST' };
    const expected: ExpectedBinding = { businessId: r.businessId as string, purpose: r.purpose as EvidenceSigningPurpose, evidenceType: r.evidenceType as string };
    const evidenceId = r.evidenceId;
    const auth = await this.authorize('retrieve', expected, evidenceId);
    if (typeof auth === 'string') return { ok: false, reason: auth };

    let row: Record<string, unknown> | undefined;
    try { row = await this.as(READER_ROLE, async tx => (await tx.execute(sql`select * from public.evidence_custody_fetch(${expected.businessId}::uuid, ${evidenceId}::uuid, ${auth.workloadId}::text)`)).rows[0] as Record<string, unknown> | undefined); }
    catch (e) { return { ok: false, reason: mapDbError(e) }; }
    if (!row) return { ok: false, reason: 'NOT_FOUND' }; // missing and foreign records are indistinguishable

    const record = (outcome: string, reason: string): Promise<boolean> => this.as(READER_ROLE, async tx => { await tx.execute(sql`select public.evidence_custody_record_verification(${expected.businessId}::uuid, ${evidenceId}::uuid, ${auth.workloadId}::text, ${outcome}::text, ${reason}::text)`); return true; }).catch(() => false);
    const fail = async (reason: CustodyDenial, outcome: 'FAILED' | 'KEY_UNAVAILABLE' | 'KEY_REVOKED' = 'FAILED'): Promise<RetrieveResult> => {
      if (!(await record(outcome, reason))) return { ok: false, reason: 'STORE_UNAVAILABLE' };
      return { ok: false, reason };
    };

    const claims: EvidenceClaims = {
      schema: String(row.schema) as EvidenceClaims['schema'], schemaVersion: Number(row.schema_version) as EvidenceClaims['schemaVersion'], evidenceType: String(row.evidence_type), purpose: String(row.purpose) as EvidenceSigningPurpose,
      environment: String(row.environment) as WorkloadEnvironment, businessId: String(row.business_id), workloadId: String(row.signer_workload_id), keyId: String(row.key_id), keyVersion: Number(row.key_version),
      algorithm: String(row.algorithm) as EvidenceClaims['algorithm'], signedAtMs: Number(row.signed_at_ms), payloadSha256: String(row.payload_sha256),
    };
    const payloadCanonical = String(row.payload_canonical);
    const recomputed = await contentDigest({ ...claims, signerWorkloadId: claims.workloadId, payloadCanonical, signature: String(row.signature) });
    if (recomputed !== String(row.content_digest) || Number(row.version) !== 1) return fail('CUSTODY_RECORD_INCONSISTENT');
    let payload: unknown;
    try { payload = JSON.parse(payloadCanonical); } catch { return fail('CUSTODY_RECORD_INCONSISTENT'); }

    // the stored envelope is verified AGAIN, now, against the current key directory and the explicit verification policy
    const v = await this.verifier.verify({ claims, payload, signature: String(row.signature) }, { ...expected, environment: this.d.environment });
    if (!v.ok) return fail(v.reason, v.reason === 'KEY_REVOKED' ? 'KEY_REVOKED' : v.reason === 'KEYS_UNAVAILABLE' || v.reason === 'KEY_UNKNOWN' ? 'KEY_UNAVAILABLE' : 'FAILED');
    if (!(await record('SUCCEEDED', 'AUTHENTIC'))) return { ok: false, reason: 'STORE_UNAVAILABLE' };
    return {
      ok: true, evidenceId, authenticity: 'AUTHENTIC', financialAuthorization: 'NOT_GRANTED', claims: v.claims, payload: v.payload, keyState: v.keyState,
      custody: Object.freeze({ status: 'STORED', recordVersion: Number(row.version), persistedAtMs: Number(row.created_at_ms), custodianWorkloadId: String(row.custodian_workload_id) }),
    };
  }
}
