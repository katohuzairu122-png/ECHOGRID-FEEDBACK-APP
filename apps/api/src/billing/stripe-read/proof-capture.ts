import { canonicalJson, sha256Hex } from './bundle-builder';
import { PERFORMABLE_METHODS, type FailureClass, type ReadMethodId } from './capability-registry';
import { evaluateCompatibility, mappingKey, MAPPING_CONTRACT_VERSION, observeShape, type CompatibilityResult, type MappingRegistry, type MappingVerification, type ShapeObservation } from './mapping-authority';
import { profileFor } from './provider-profiles';
import { checkRead, type GateDenial, type ReadGate } from './read-gate';
import { makeEmitter, type AuditSink } from './read-types';
import { CredentialDenied, ProviderReadError, STRIPE_API_VERSION, type CredentialDenial, type PerformableMethod, type StripeReadTransport } from './transport';

/**
 * S08-D1D3-DEV-09: test-mode PROOF infrastructure. A proof is an immutable record of what ONE authorized, GET-only test-mode read returned, reduced to what a mapping decision needs: the shape (types, and
 * the values of enum-typed mapped fields only), a fingerprint of the response, the API version, the verified account and mode, the trusted capture time, the authorization used and where the bytes came from.
 * No raw body, id, amount, name or metadata is stored.
 *
 * WHERE THE BYTES CAME FROM decides what a proof can do. Only `REAL_NETWORK` (the transport used the platform fetch) can move a mapping to TEST_MODE_VERIFIED. A proof captured through an injected
 * transport (a test double), or produced from a fixture, is recorded and can be compared with the mappings, and can even reveal drift in a report, but it cannot raise any status. Nothing here contacts
 * Stripe by itself: capture needs a transport, an approved authorization record for the exact method (PROOF purpose) and a credential bound to the account and workload, none of which exist yet.
 */
export type CaptureOrigin = 'REAL_NETWORK' | 'INJECTED_TRANSPORT' | 'SYNTHETIC_FIXTURE';
export interface ProofRecord {
  readonly proofId: string;
  readonly mappingContractVersion: typeof MAPPING_CONTRACT_VERSION;
  readonly methodId: ReadMethodId;
  readonly apiVersion: string;
  readonly businessId: string;
  readonly accountId: string;
  readonly workloadId: string;
  readonly authorizationId: string;
  readonly capturedAtMs: number;
  readonly captureOrigin: CaptureOrigin;
  readonly mode: 'test';
  readonly accountVerified: true;
  /** Hash of the request subject (for example the invoice id); the id itself is not stored. */
  readonly subjectHash: string;
  readonly responseFingerprint: string;
  readonly shapeFingerprint: string;
  readonly shape: ShapeObservation;
  readonly compatibility: readonly CompatibilityResult[];
  readonly drift: readonly string[];
}

const sealedProofs = new WeakSet<object>();
export const isSealedProof = (x: unknown): x is ProofRecord => x !== null && typeof x === 'object' && sealedProofs.has(x);

/** Append-only. A second capture with the same identity returns the first record (idempotent); there is no update and no delete. */
export interface ProofStore { append(p: ProofRecord): { record: ProofRecord; duplicate: boolean }; get(proofId: string): ProofRecord | null; list(): readonly ProofRecord[] }
export function createInMemoryProofStore(): ProofStore {
  const rows = new Map<string, ProofRecord>();
  return {
    append(p) {
      if (!isSealedProof(p)) throw new Error('PROOF_NOT_SEALED');
      const existing = rows.get(p.proofId);
      if (existing) return { record: existing, duplicate: true };
      rows.set(p.proofId, p); return { record: p, duplicate: false };
    },
    get: id => rows.get(id) ?? null,
    list: () => [...rows.values()],
  };
}

/** Builds a sealed proof from one response body. Exposed for fixtures and tests; only `captureProof` supplies REAL_NETWORK. */
export async function buildProof(i: Readonly<{
  methodId: ReadMethodId; apiVersion: string; businessId: string; accountId: string; workloadId: string; authorizationId: string; capturedAtMs: number; captureOrigin: CaptureOrigin; subject: string; body: unknown; mapping: MappingRegistry;
}>): Promise<ProofRecord> {
  const mappings = i.mapping.for(i.methodId, i.apiVersion);
  const shape = observeShape(i.body, mappings);
  const compatibility = evaluateCompatibility(shape, mappings);
  const drift = compatibility.filter(c => c.result === 'TYPE_MISMATCH' || c.result === 'ENUM_UNKNOWN').map(c => `${c.result}:${c.sourceField}`);
  const responseFingerprint = await sha256Hex(canonicalJson(i.body));
  const shapeFingerprint = await sha256Hex(canonicalJson(shape));
  const proofId = await sha256Hex(canonicalJson([i.methodId, i.apiVersion, i.accountId, i.workloadId, i.captureOrigin, responseFingerprint]));
  const rec: ProofRecord = Object.freeze({
    proofId, mappingContractVersion: MAPPING_CONTRACT_VERSION, methodId: i.methodId, apiVersion: i.apiVersion, businessId: i.businessId, accountId: i.accountId, workloadId: i.workloadId, authorizationId: i.authorizationId,
    capturedAtMs: i.capturedAtMs, captureOrigin: i.captureOrigin, mode: 'test' as const, accountVerified: true as const, subjectHash: await sha256Hex(`proof-subject|${i.subject}`), responseFingerprint, shapeFingerprint, shape,
    compatibility: Object.freeze(compatibility), drift: Object.freeze(drift),
  });
  sealedProofs.add(rec);
  return rec;
}

export type ProofDenial = GateDenial | CredentialDenial | 'INVALID_REQUEST' | 'UNSUPPORTED_API_VERSION' | 'ACCOUNT_MISMATCH' | 'ACCOUNT_RESPONSE_INVALID' | 'OBJECT_MISMATCH' | 'INVOICE_IDENTITY_MISMATCH' | 'REALM_MISMATCH';
export type ProofOutcome =
  | Readonly<{ ok: true; proof: ProofRecord; duplicate: boolean }>
  | Readonly<{ ok: false; kind: 'DENIED'; reason: ProofDenial }>
  | Readonly<{ ok: false; kind: 'PROVIDER_FAILURE'; failureClass: FailureClass }>;

const INVOICE_ID = /^in_[A-Za-z0-9]+$/;
const ACCOUNT = /^acct_[A-Za-z0-9]+$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,159}$/;

/**
 * Captures ONE proof. Sequence: validate the request, profile the API version, gate the account read (PROOF purpose), read the account and compare its id with the approved account, gate and perform the
 * target read, check the response's own identity and mode, then minimize, fingerprint and append. Every request is gated immediately before it is made. Provider detail never leaves: failures are classes.
 */
export async function captureProof(
  deps: Readonly<{ transport: StripeReadTransport; gate: ReadGate; store: ProofStore; clock: () => number; audit: AuditSink; apiVersion?: string }>,
  req: Readonly<{ businessId: string; accountId: string; methodId: ReadMethodId; invoiceId?: string }>,
): Promise<ProofOutcome> {
  const emit = makeEmitter(deps.audit, deps.clock, 'STRIPE_TEST_READ');
  const deny = (reason: ProofDenial, method: ReadMethodId | 'UNKNOWN' = 'UNKNOWN'): ProofOutcome => { emit('stripe_read.denied', method, reason, { businessId: String(req?.businessId ?? ''), invoiceId: String(req?.invoiceId ?? '') }); return { ok: false, kind: 'DENIED', reason }; };
  const apiVersion = deps.apiVersion ?? STRIPE_API_VERSION;
  if (!req || !TOKEN.test(String(req.businessId)) || !ACCOUNT.test(String(req.accountId)) || !PERFORMABLE_METHODS.includes(req.methodId) || (req.methodId === 'INVOICE_RETRIEVE' && !INVOICE_ID.test(String(req.invoiceId)))) return deny('INVALID_REQUEST');
  if (profileFor(apiVersion) === null) return deny('UNSUPPORTED_API_VERSION');
  const binding = { accountId: req.accountId, workloadId: deps.gate.workloadId };
  const scope = { businessId: req.businessId, invoiceId: req.invoiceId ?? '' };
  let authorizationId = '';

  const read = async (method: PerformableMethod, params?: { invoiceId: string }): Promise<{ ok: true; body: unknown } | { ok: false; out: ProofOutcome }> => {
    const g = await checkRead(deps.gate, { businessId: req.businessId, accountId: req.accountId, methodId: method, apiVersion, purpose: 'PROOF' }, deps.clock()); // immediately before THIS request
    if (!g.ok) return { ok: false, out: deny(g.reason, method) };
    if (method === req.methodId) authorizationId = g.authorizationId;
    emit('stripe_read.attempt', method, null, scope);
    try { return { ok: true, body: await deps.transport.get(method, params, binding) }; }
    catch (e) {
      if (e instanceof CredentialDenied) return { ok: false, out: deny(e.code, method) };
      const failureClass: FailureClass = e instanceof ProviderReadError ? e.failureClass : 'NETWORK';
      emit('stripe_read.failure', method, failureClass, scope);
      return { ok: false, out: { ok: false, kind: 'PROVIDER_FAILURE', failureClass } };
    }
  };

  // 1. account and mode verification: the credential must belong to the approved account (this read is the proof itself when the method is the account read)
  const acc = await read('ACCOUNT_RETRIEVE_CURRENT');
  if (!acc.ok) return acc.out;
  const ab = acc.body as { object?: unknown; id?: unknown } | null;
  if (!ab || typeof ab !== 'object' || ab.object !== 'account' || typeof ab.id !== 'string') return deny('ACCOUNT_RESPONSE_INVALID', 'ACCOUNT_RETRIEVE_CURRENT');
  if (ab.id !== req.accountId) return deny('ACCOUNT_MISMATCH', 'ACCOUNT_RETRIEVE_CURRENT');
  let body = acc.body; let subject = req.accountId;
  if (req.methodId === 'INVOICE_RETRIEVE') {
    const inv = await read('INVOICE_RETRIEVE', { invoiceId: req.invoiceId as string });
    if (!inv.ok) return inv.out;
    const ib = inv.body as { object?: unknown; id?: unknown; livemode?: unknown } | null;
    if (!ib || typeof ib !== 'object' || ib.object !== 'invoice') return deny('OBJECT_MISMATCH', 'INVOICE_RETRIEVE');
    if (ib.id !== req.invoiceId) return deny('INVOICE_IDENTITY_MISMATCH', 'INVOICE_RETRIEVE');
    if (ib.livemode !== false) return deny('REALM_MISMATCH', 'INVOICE_RETRIEVE'); // wrong-mode response evidence is never recorded
    body = inv.body; subject = req.invoiceId as string;
  }
  const origin: CaptureOrigin = deps.transport.networkSource === 'GLOBAL_FETCH' ? 'REAL_NETWORK' : deps.transport.networkSource === 'INJECTED' ? 'INJECTED_TRANSPORT' : 'SYNTHETIC_FIXTURE';
  const proof = await buildProof({ methodId: req.methodId, apiVersion, businessId: req.businessId, accountId: req.accountId, workloadId: deps.gate.workloadId, authorizationId, capturedAtMs: deps.clock(), captureOrigin: origin, subject, body, mapping: deps.gate.mapping });
  const { record, duplicate } = deps.store.append(proof);
  emit('stripe_read.success', req.methodId, duplicate ? 'DUPLICATE_PROOF' : null, scope);
  return { ok: true, proof: record, duplicate };
}

export interface MappingUpdate { readonly key: string; readonly from: MappingVerification; readonly to: MappingVerification }
export type ProofApplication = Readonly<{ registry: MappingRegistry; changes: readonly MappingUpdate[]; note: 'APPLIED' | 'PROOF_NOT_SEALED' | 'ORIGIN_CANNOT_VERIFY' | 'UNSUPPORTED_API_VERSION' }>;

/**
 * The ONLY operation that can move a mapping's status. It returns a NEW registry. Rules: the proof must be a sealed record of a REAL_NETWORK capture (anything else changes nothing); a COMPATIBLE field of an
 * unproven or drifted mapping becomes TEST_MODE_VERIFIED, citing the proof; a TYPE_MISMATCH or ENUM_UNKNOWN field becomes SCHEMA_DRIFT (a verified mapping can be demoted by later real evidence); ABSENT
 * fields and UNSUPPORTED mappings never change.
 */
export function applyProof(registry: MappingRegistry, proof: unknown): ProofApplication {
  if (!isSealedProof(proof)) return { registry, changes: [], note: 'PROOF_NOT_SEALED' };
  if (proof.captureOrigin !== 'REAL_NETWORK') return { registry, changes: [], note: 'ORIGIN_CANNOT_VERIFY' };
  if (profileFor(proof.apiVersion) === null) return { registry, changes: [], note: 'UNSUPPORTED_API_VERSION' };
  const updates = new Map<string, { status: MappingVerification; verifiedByProofId: string | null }>(); const changes: MappingUpdate[] = [];
  for (const mp of registry.for(proof.methodId, proof.apiVersion)) {
    if (mp.status === 'UNSUPPORTED') continue;
    const c = proof.compatibility.find(x => x.sourceField === mp.sourceField);
    if (!c) continue;
    let to: MappingVerification | null = null;
    if (c.result === 'COMPATIBLE') to = 'TEST_MODE_VERIFIED';
    else if (c.result === 'TYPE_MISMATCH' || c.result === 'ENUM_UNKNOWN') to = 'SCHEMA_DRIFT';
    if (to && to !== mp.status) { updates.set(mappingKey(mp), { status: to, verifiedByProofId: to === 'TEST_MODE_VERIFIED' ? proof.proofId : null }); changes.push({ key: mappingKey(mp), from: mp.status, to }); }
  }
  return { registry: updates.size ? registry.replace(updates) : registry, changes, note: 'APPLIED' };
}
