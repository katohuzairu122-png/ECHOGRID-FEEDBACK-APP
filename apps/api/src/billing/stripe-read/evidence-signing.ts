import { canonicalJson, sha256Hex } from './bundle-builder';
import {
  KEY_ENVIRONMENTS, KEY_ID, PURPOSE_EVIDENCE_TYPES, SIGNING_ALGORITHMS, isInt, resolveVerificationPolicy, parseKeyDirectory,
  type EvidenceKeyDirectory, type EvidenceKeyRecord, type EvidenceSignerProvider, type EvidenceSigningPurpose, type SigningAlgorithm, type VerificationPolicy,
} from './evidence-signing-keys';
import { SIGNING_BUSINESS_ID, type SigningWorkloadAuthority, type SigningWorkloadDenial } from './evidence-signing-workload';
import type { WorkloadEnvironment } from './workload-identity';

/**
 * S08-D1D3-DEV-14: the TRUSTED EVIDENCE SIGNING BOUNDARY and its strict verifier.
 *
 * AUTHENTICITY ONLY. A signature proves that an authorized signing workload attested THESE bytes, for THIS business, purpose, evidence type and environment, under THIS key version. It is not provider
 * verification and not financial authorization: payloads that carry a verdict (ELIGIBLE, APPROVED, ...) are refused at signing, and a successful verification returns `financialAuthorization: 'NOT_GRANTED'`
 * as a constant. Nothing here touches the database, the ledger, Stripe, the read-authorization policy or the settlement gates; no financial effect can follow from signing or from verifying.
 *
 *  - The signer is resolved from TRUSTED configuration (no identity parameter), then checked for environment, purpose, evidence type and business on every request. The key is the newest ACTIVE version for the
 *    purpose and environment, re-read from the directory at signing time. Private material stays behind `EvidenceSignerProvider`; errors from it are mapped to fixed codes and never echoed.
 *  - The signed message is deterministic, versioned, domain-separated (a different label from observation and settlement signatures) and length-prefixed per field; the payload is bound through its SHA-256
 *    over canonical JSON. A signature cannot be reused across businesses, environments, purposes, evidence types, key versions or schema versions.
 *  - Verification checks structure, schema, expected bindings, key id, key version, algorithm, key purpose and environment, lifecycle state (revoked: never; retired or expired issuance: only under an explicit
 *    policy and inside the retention deadline), the signing time against the key window, payload integrity and the signature.
 */
export const EVIDENCE_SCHEMA = 'S08-SIGNED-EVIDENCE' as const;
export const EVIDENCE_SCHEMA_VERSION = 1 as const;
const SIGNATURE_LABEL = 'S08/EVIDENCE-SIGNATURE/1';
const MAX_SKEW_MS = 60_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const DIGEST = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[0-9a-f]{128}$/;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const toHex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map(x => parseInt(x, 16)));

export interface EvidenceClaims {
  readonly schema: typeof EVIDENCE_SCHEMA; readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION; readonly evidenceType: string; readonly purpose: EvidenceSigningPurpose; readonly environment: WorkloadEnvironment;
  readonly businessId: string; readonly workloadId: string; readonly keyId: string; readonly keyVersion: number; readonly algorithm: SigningAlgorithm; readonly signedAtMs: number; readonly payloadSha256: string;
}
const CLAIM_KEYS: ReadonlyArray<keyof EvidenceClaims> = ['schema', 'schemaVersion', 'evidenceType', 'purpose', 'environment', 'businessId', 'workloadId', 'keyId', 'keyVersion', 'algorithm', 'signedAtMs', 'payloadSha256'];
export interface SignedEvidence { readonly claims: EvidenceClaims; readonly payload: Readonly<Record<string, unknown>>; readonly signature: string }
/** Non-secret verification metadata returned with signed evidence. */
export interface SigningMetadata { readonly keyId: string; readonly keyVersion: number; readonly algorithm: SigningAlgorithm; readonly environment: WorkloadEnvironment }

export function evidenceMessage(c: EvidenceClaims): Uint8Array {
  const parts = [SIGNATURE_LABEL, ...CLAIM_KEYS.map(k => String(c[k]))];
  return new TextEncoder().encode(parts.map(v => `${v.length}:${v};`).join(''));
}

// ---- payload hygiene ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const FORBIDDEN_KEYS = new Set(['eligible', 'eligibility', 'approved', 'approval', 'approvalenabled', 'authorized', 'authorization', 'verdict', 'decision', 'financialdecision', 'settlementstatus', 'consumable', 'consumed']);
const FORBIDDEN_VALUES = new Set(['ELIGIBLE', 'APPROVED', 'AUTHORIZED', 'SETTLEMENT_ELIGIBLE']);
/** Plain, JSON-safe, bounded and verdict-free, or null. A caller-supplied verdict is never independent authorization, so it is never signed. */
export function cleanPayload(p: unknown): Record<string, unknown> | null {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return null;
  let nodes = 0;
  const ok = (v: unknown, depth: number): boolean => {
    if (++nodes > 2000 || depth > 8) return false;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') return !FORBIDDEN_VALUES.has(v.trim().toUpperCase());
    if (Array.isArray(v)) return v.every(x => ok(x, depth + 1));
    if (typeof v === 'object') {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return false;
      return Object.keys(v as object).every(k => k !== '__proto__' && !FORBIDDEN_KEYS.has(k.toLowerCase().replace(/[^a-z0-9]/g, '')) && ok((v as Record<string, unknown>)[k], depth + 1));
    }
    return false; // undefined, bigint, function, symbol
  };
  if (!ok(p, 0)) return null;
  if (new TextEncoder().encode(canonicalJson(p)).length > MAX_PAYLOAD_BYTES) return null;
  return p as Record<string, unknown>;
}

// ---- signing --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type SigningDenial = SigningWorkloadDenial | 'INVALID_REQUEST' | 'PAYLOAD_REJECTED' | 'SIGNING_KEY_UNAVAILABLE' | 'SIGNER_UNAVAILABLE' | 'SIGNING_FAILED';
export type SignResult = Readonly<{ ok: true; evidence: SignedEvidence; metadata: SigningMetadata }> | Readonly<{ ok: false; reason: SigningDenial }>;
export interface SigningRequest { readonly businessId: string; readonly purpose: EvidenceSigningPurpose; readonly evidenceType: string; readonly payload: Readonly<Record<string, unknown>> }
export interface EvidenceSigningBoundary { sign(request: SigningRequest): Promise<SignResult> }

export function createEvidenceSigningBoundary(deps: Readonly<{
  authority: SigningWorkloadAuthority; keys: EvidenceKeyDirectory; signers: EvidenceSignerProvider; environment: WorkloadEnvironment; clock: () => number;
}>): EvidenceSigningBoundary {
  const deny = (reason: SigningDenial): SignResult => ({ ok: false, reason });
  return Object.freeze({
    async sign(request: SigningRequest): Promise<SignResult> {
      const r = request as unknown as Record<string, unknown>;
      // strict request: no identity, key id, verdict or any other field can be smuggled in
      if (r === null || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).length !== 4 || !['businessId', 'purpose', 'evidenceType', 'payload'].every(k => has(r, k))) return deny('INVALID_REQUEST');
      const { businessId, purpose, evidenceType } = r as { businessId: unknown; purpose: unknown; evidenceType: unknown };
      if (typeof businessId !== 'string' || !SIGNING_BUSINESS_ID.test(businessId) || typeof purpose !== 'string' || !has(PURPOSE_EVIDENCE_TYPES, purpose) || typeof evidenceType !== 'string' || !PURPOSE_EVIDENCE_TYPES[purpose as EvidenceSigningPurpose].includes(evidenceType)) return deny('INVALID_REQUEST');
      const payload = cleanPayload(r.payload);
      if (!payload) return deny('PAYLOAD_REJECTED');

      const who = await deps.authority.resolve();
      if (!who.ok) return deny(who.reason);
      const denied = await deps.authority.check(who.identity, { environment: deps.environment, purpose, evidenceType, businessId });
      if (denied) return deny(denied);

      let records: EvidenceKeyRecord[] | null;
      try { records = parseKeyDirectory(await deps.keys.load()); } catch { return deny('SIGNING_KEY_UNAVAILABLE'); }
      if (!records) return deny('SIGNING_KEY_UNAVAILABLE');
      const nowMs = deps.clock();
      const key = records
        .filter(k => k.state === 'ACTIVE' && k.purpose === purpose && k.environment === deps.environment && k.notBeforeMs <= nowMs && nowMs < k.notAfterMs)
        .sort((a, b) => b.version - a.version)[0];
      if (!key) return deny('SIGNING_KEY_UNAVAILABLE');
      let signer;
      try { signer = deps.signers.signerFor(key.keyId); } catch { return deny('SIGNER_UNAVAILABLE'); }
      if (!signer || signer.keyId !== key.keyId || typeof signer.sign !== 'function') return deny('SIGNER_UNAVAILABLE');

      const claims: EvidenceClaims = {
        schema: EVIDENCE_SCHEMA, schemaVersion: EVIDENCE_SCHEMA_VERSION, evidenceType, purpose: purpose as EvidenceSigningPurpose, environment: deps.environment, businessId, workloadId: who.identity.workloadId,
        keyId: key.keyId, keyVersion: key.version, algorithm: key.algorithm, signedAtMs: nowMs, payloadSha256: await sha256Hex(canonicalJson(payload)),
      };
      let signature: string;
      try { signature = toHex(await signer.sign(evidenceMessage(claims))); } catch { return deny('SIGNING_FAILED'); } // the provider's error text is never propagated
      if (!SIGNATURE.test(signature)) return deny('SIGNING_FAILED');
      return {
        ok: true,
        evidence: Object.freeze({ claims: Object.freeze(claims), payload: JSON.parse(canonicalJson(payload)) as Record<string, unknown>, signature }),
        metadata: Object.freeze({ keyId: key.keyId, keyVersion: key.version, algorithm: key.algorithm, environment: deps.environment }),
      };
    },
  });
}

// ---- verification ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type EvidenceDenial =
  | 'EVIDENCE_MALFORMED' | 'SCHEMA_MISMATCH' | 'BINDING_MISMATCH' | 'KEYS_UNAVAILABLE' | 'KEY_UNKNOWN' | 'KEY_VERSION_MISMATCH' | 'ALGORITHM_UNSUPPORTED' | 'KEY_PURPOSE_MISMATCH' | 'KEY_ENVIRONMENT_MISMATCH'
  | 'KEY_NOT_ACTIVE' | 'KEY_REVOKED' | 'KEY_RETIRED_NOT_ACCEPTED' | 'KEY_RETENTION_EXPIRED' | 'SIGNED_OUTSIDE_KEY_WINDOW' | 'SIGNED_IN_FUTURE' | 'PAYLOAD_TAMPERED' | 'SIGNATURE_INVALID';
export interface ExpectedEvidence { readonly businessId: string; readonly purpose: EvidenceSigningPurpose; readonly evidenceType: string; readonly environment: WorkloadEnvironment }
export type VerifiedEvidence =
  | Readonly<{ ok: true; authenticity: 'AUTHENTIC'; financialAuthorization: 'NOT_GRANTED'; claims: EvidenceClaims; payload: Readonly<Record<string, unknown>>; keyState: 'ACTIVE' | 'RETIRED' }>
  | Readonly<{ ok: false; reason: EvidenceDenial }>;
export interface EvidenceVerifier { verify(evidence: unknown, expected: ExpectedEvidence): Promise<VerifiedEvidence> }

function parseEvidence(raw: unknown): SignedEvidence | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (Object.keys(e).length !== 3 || !['claims', 'payload', 'signature'].every(k => has(e, k))) return null;
  const c = e.claims as Record<string, unknown> | null;
  if (c === null || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length !== CLAIM_KEYS.length || !CLAIM_KEYS.every(k => has(c, k))) return null;
  if (typeof c.schema !== 'string' || !isInt(c.schemaVersion)) return null;
  if (typeof c.evidenceType !== 'string' || typeof c.purpose !== 'string' || typeof c.environment !== 'string' || typeof c.businessId !== 'string' || !SIGNING_BUSINESS_ID.test(c.businessId)) return null;
  if (typeof c.workloadId !== 'string' || typeof c.keyId !== 'string' || !KEY_ID.test(c.keyId) || !isInt(c.keyVersion) || typeof c.algorithm !== 'string' || !isInt(c.signedAtMs)) return null;
  if (typeof c.payloadSha256 !== 'string' || !DIGEST.test(c.payloadSha256) || typeof e.signature !== 'string' || !SIGNATURE.test(e.signature)) return null;
  if (e.payload === null || typeof e.payload !== 'object' || Array.isArray(e.payload)) return null;
  return e as unknown as SignedEvidence;
}

export function createEvidenceVerifier(deps: Readonly<{ keys: EvidenceKeyDirectory; policy?: unknown; clock: () => number }>): EvidenceVerifier {
  const policy: VerificationPolicy = resolveVerificationPolicy(deps.policy);
  const fail = (reason: EvidenceDenial): VerifiedEvidence => ({ ok: false, reason });
  return Object.freeze({
    async verify(raw: unknown, expected: ExpectedEvidence): Promise<VerifiedEvidence> {
      const ev = parseEvidence(raw);
      if (!ev) return fail('EVIDENCE_MALFORMED');
      const c = ev.claims;
      if (c.schema !== EVIDENCE_SCHEMA || c.schemaVersion !== EVIDENCE_SCHEMA_VERSION) return fail('SCHEMA_MISMATCH');
      if (!expected || c.businessId !== expected.businessId || c.purpose !== expected.purpose || c.evidenceType !== expected.evidenceType || c.environment !== expected.environment
        || !(KEY_ENVIRONMENTS as readonly string[]).includes(expected.environment) || !(PURPOSE_EVIDENCE_TYPES[c.purpose as EvidenceSigningPurpose] ?? []).includes(c.evidenceType)) return fail('BINDING_MISMATCH');

      let records: EvidenceKeyRecord[] | null;
      try { records = parseKeyDirectory(await deps.keys.load()); } catch { return fail('KEYS_UNAVAILABLE'); }
      if (!records) return fail('KEYS_UNAVAILABLE');
      const key = records.find(k => k.keyId === c.keyId);
      if (!key) return fail('KEY_UNKNOWN');
      if (key.version !== c.keyVersion) return fail('KEY_VERSION_MISMATCH');
      if (!(SIGNING_ALGORITHMS as readonly string[]).includes(c.algorithm) || c.algorithm !== key.algorithm) return fail('ALGORITHM_UNSUPPORTED');
      if (key.purpose !== c.purpose) return fail('KEY_PURPOSE_MISMATCH');
      if (key.environment !== c.environment) return fail('KEY_ENVIRONMENT_MISMATCH');

      const nowMs = deps.clock();
      if (key.state === 'REVOKED') return fail('KEY_REVOKED'); // a compromised key's signatures cannot be told from forgeries: never accepted, under any policy
      if (key.state === 'PENDING') return fail('KEY_NOT_ACTIVE');
      if (c.signedAtMs > nowMs + MAX_SKEW_MS) return fail('SIGNED_IN_FUTURE');
      if (c.signedAtMs < key.notBeforeMs || c.signedAtMs >= key.notAfterMs || (key.retiredAtMs !== null && c.signedAtMs >= key.retiredAtMs)) return fail('SIGNED_OUTSIDE_KEY_WINDOW');
      // an ACTIVE key past its issuance window is, for verification, a retired key
      const effective: 'ACTIVE' | 'RETIRED' = key.state === 'RETIRED' || nowMs >= key.notAfterMs ? 'RETIRED' : 'ACTIVE';
      if (effective === 'RETIRED') {
        if (policy.retiredKeys !== 'ACCEPT_WITHIN_RETENTION') return fail('KEY_RETIRED_NOT_ACCEPTED');
        if (nowMs >= key.verifyUntilMs) return fail('KEY_RETENTION_EXPIRED');
      }

      if (await sha256Hex(canonicalJson(ev.payload)) !== c.payloadSha256) return fail('PAYLOAD_TAMPERED');
      let valid = false;
      try {
        const pub = await crypto.subtle.importKey('raw', fromHex(key.publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
        valid = await crypto.subtle.verify({ name: 'Ed25519' }, pub, fromHex(ev.signature), evidenceMessage(c));
      } catch { valid = false; }
      if (!valid) return fail('SIGNATURE_INVALID');
      return { ok: true, authenticity: 'AUTHENTIC', financialAuthorization: 'NOT_GRANTED', claims: c, payload: ev.payload, keyState: effective };
    },
  });
}
