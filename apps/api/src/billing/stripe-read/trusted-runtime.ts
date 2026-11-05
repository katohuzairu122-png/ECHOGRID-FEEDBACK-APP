import type { FailureClass, ReadMethodId } from './capability-registry';
import { canonicalJson, sha256Hex } from './bundle-builder';
import { checkRead, type GateDenial, type GatePurpose, type ReadGate } from './read-gate';
import type { MappingRegistry } from './mapping-authority';
import { profileFor } from './provider-profiles';
import { CredentialDenied, createStripeGetTransport, ProviderReadError, StripeReadConfigError, type CredentialDenial, type CredentialSource, type PerformableMethod, type StripeReadTransport } from './transport';

/**
 * S08-D1D3-DEV-10: the TRUSTED RUNTIME BOUNDARY. Authenticity of a Stripe observation is established here and only here, by a signature that an untrusted adapter cannot produce, and never by a
 * field a caller or a provider object supplies (DEV-09 trusted a self-reported `networkSource`; that field no longer exists).
 *
 *   workload -> authorization (durable store) -> mapping gate -> bound credential -> restricted GET transport -> SIGNED OBSERVATION -> verifier -> normalizer -> pipeline
 *
 *  - `createTrustedStripeRuntime` builds its OWN transport from the platform `fetch` and a bound credential source. There is no transport, fetch or response parameter, so no test double and no
 *    adapter can be passed in and have its output called real. It signs with a runtime key whose public half the verifier trusts for the purpose TRUSTED_RUNTIME.
 *  - A SYNTHETIC runtime (synthetic-runtime.ts, not exported from the package index) can wrap a test transport, but it can sign only with a key the key ring marks SYNTHETIC_RUNTIME. Its observations
 *    verify as synthetic and never as REAL_NETWORK, whatever they claim.
 *  - A `SignedObservation` carries claims (fingerprint, workload, business, account, realm, method, API version, subject, request id, observation time, authorization reference, contract version),
 *    the response body and an Ed25519 signature over a versioned, length-prefixed, domain-separated encoding of the claims. The verifier recomputes the fingerprint from the body, checks the signature against
 *    the trusted key ring, the key's purpose, validity window and revocation, and the expected binding. It also requires process identity: only an object this module issued is accepted, so cloning,
 *    relabelling or substituting an object gains nothing (a different process verifies the signature alone, which is what `crossProcess` mode exercises).
 *  - Fail closed: no key ring, a key that is unknown, revoked, expired, not yet valid or of the wrong purpose, a signing failure, or an unavailable authorization store means no observation.
 * Production signing-key custody and the runtime identity/secrets provisioning are owner decisions; the key ring is trusted configuration, and a party that controls it can trust any key.
 */
export const OBSERVATION_CONTRACT_VERSION = 'S08-STRIPE-OBSERVATION/1' as const;
const SIGNATURE_LABEL = 'ECHO-GRID:S08-STRIPE-OBSERVATION-SIG/1';
export type ObservationKind = 'REAL_NETWORK' | 'SYNTHETIC_RUNTIME';
export type KeyPurpose = 'TRUSTED_RUNTIME' | 'SYNTHETIC_RUNTIME';
const KIND_PURPOSE: Readonly<Record<ObservationKind, KeyPurpose>> = Object.freeze({ REAL_NETWORK: 'TRUSTED_RUNTIME', SYNTHETIC_RUNTIME: 'SYNTHETIC_RUNTIME' });

const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/;
const SIGNATURE_HEX = /^[0-9a-f]{128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,159}$/;
const ACCOUNT = /^acct_[A-Za-z0-9]+$/;
const INVOICE_ID = /^in_[A-Za-z0-9]+$/;
const REQUEST_ID = /^[0-9a-f-]{36}$/;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const toHex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map(x => parseInt(x, 16)));

// ---- signing authority and key ring ---------------------------------------------------------------------------------------------------------------------------------------------------------

/** The runtime's signing credential. The private key lives inside `sign`; nothing exposes it. */
export interface RuntimeSigner { readonly keyId: string; sign(message: Uint8Array): Promise<Uint8Array> }
/** Builds a signer from an Ed25519 PKCS#8 private key (base64). The imported key is non-extractable. Throws a fixed code and never echoes key material. */
export async function createRuntimeSigner(keyId: string, pkcs8Base64: string): Promise<RuntimeSigner> {
  if (!KEY_ID.test(keyId)) throw new StripeReadConfigError('CREDENTIAL_SOURCE_INVALID');
  let key: CryptoKey;
  try { key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(Buffer.from(pkcs8Base64, 'base64')), { name: 'Ed25519' }, false, ['sign']); } catch { throw new StripeReadConfigError('CREDENTIAL_SOURCE_INVALID'); }
  return Object.freeze({ keyId, sign: async (m: Uint8Array) => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, m)) });
}

/** One trusted public key. The key ring is TRUSTED CONFIGURATION: public keys only (the verifier can check, never create), with a purpose, a validity window and a revocation mark. */
export interface TrustedKeyEntry {
  readonly publicKeyHex: string; readonly purpose: KeyPurpose;
  /** The ISSUANCE window: a key signs new observations only inside it. */
  readonly notBeforeMs: number; readonly notAfterMs: number;
  /** DEV-11 retained-key policy: until when evidence signed inside the issuance window still VERIFIES (default: the end of the issuance window). A revoked key verifies nothing, whatever this says. */
  readonly verifyUntilMs?: number;
  readonly revokedAtMs: number | null;
}
export type TrustedKeyRing = Readonly<Record<string, TrustedKeyEntry>>;
export type KeyRingSource = () => TrustedKeyRing | Promise<TrustedKeyRing>;

export type KeyDenial = 'SIGNING_AUTHORITY_UNAVAILABLE' | 'SIGNING_KEY_NOT_TRUSTED' | 'SIGNING_KEY_PURPOSE' | 'SIGNING_KEY_EXPIRED' | 'SIGNING_KEY_NOT_YET_VALID' | 'SIGNING_KEY_REVOKED';
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

async function keyEntry(source: KeyRingSource, keyId: string, purpose: KeyPurpose, nowMs: number, mode: 'ISSUE' | 'VERIFY' = 'ISSUE'): Promise<Readonly<{ ok: true; entry: TrustedKeyEntry }> | Readonly<{ ok: false; reason: KeyDenial }>> {
  let ring: TrustedKeyRing;
  try { ring = await source(); } catch { return { ok: false, reason: 'SIGNING_AUTHORITY_UNAVAILABLE' }; }
  if (!ring || typeof ring !== 'object' || typeof keyId !== 'string' || !KEY_ID.test(keyId) || !has(ring, keyId)) return { ok: false, reason: 'SIGNING_KEY_NOT_TRUSTED' };
  const e = ring[keyId] as TrustedKeyEntry | undefined;
  if (!e || typeof e !== 'object' || typeof e.publicKeyHex !== 'string' || !PUBLIC_KEY_HEX.test(e.publicKeyHex) || !isInt(e.notBeforeMs) || !isInt(e.notAfterMs) || e.notAfterMs <= e.notBeforeMs
    || (e.revokedAtMs !== null && !isInt(e.revokedAtMs)) || (e.verifyUntilMs !== undefined && (!isInt(e.verifyUntilMs) || e.verifyUntilMs < e.notAfterMs)) || (e.purpose !== 'TRUSTED_RUNTIME' && e.purpose !== 'SYNTHETIC_RUNTIME')) return { ok: false, reason: 'SIGNING_KEY_NOT_TRUSTED' };
  if (e.purpose !== purpose) return { ok: false, reason: 'SIGNING_KEY_PURPOSE' };
  if (e.revokedAtMs !== null) return { ok: false, reason: 'SIGNING_KEY_REVOKED' };
  if (nowMs < e.notBeforeMs) return { ok: false, reason: 'SIGNING_KEY_NOT_YET_VALID' };
  if (nowMs >= (mode === 'VERIFY' ? (e.verifyUntilMs ?? e.notAfterMs) : e.notAfterMs)) return { ok: false, reason: 'SIGNING_KEY_EXPIRED' };
  return { ok: true, entry: e };
}

// ---- the signed observation -----------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ObservationClaims {
  readonly contractVersion: typeof OBSERVATION_CONTRACT_VERSION;
  readonly kind: ObservationKind;
  readonly keyId: string;
  readonly workloadId: string;
  readonly businessId: string;
  readonly accountId: string;
  readonly realm: 'test';
  readonly methodId: PerformableMethod;
  readonly apiVersion: string;
  /** The invoice id for INVOICE_RETRIEVE, the account id for ACCOUNT_RETRIEVE_CURRENT. */
  readonly subject: string;
  readonly requestId: string;
  readonly observedAtMs: number;
  readonly authorizationId: string;
  readonly authorizationVersion: number;
  /** sha256 of the canonical JSON of the response body, computed INSIDE the runtime. */
  readonly fingerprint: string;
}
export interface SignedObservation { readonly claims: ObservationClaims; readonly body: unknown; readonly signature: string }

const issued = new WeakSet<object>();
const CLAIM_KEYS: ReadonlyArray<keyof ObservationClaims> = ['contractVersion', 'kind', 'keyId', 'workloadId', 'businessId', 'accountId', 'realm', 'methodId', 'apiVersion', 'subject', 'requestId', 'observedAtMs', 'authorizationId', 'authorizationVersion', 'fingerprint'];

/** The exact signed bytes: deterministic, versioned, domain-separated from every other signature in the system (the settlement provenance label differs) and length-prefixed per field. */
export function observationMessage(c: ObservationClaims): Uint8Array {
  const parts = [SIGNATURE_LABEL, ...CLAIM_KEYS.map(k => String(c[k]))];
  return new TextEncoder().encode(parts.map(v => `${v.length}:${v};`).join(''));
}

function parseClaims(raw: unknown): ObservationClaims | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (Object.keys(c).length !== CLAIM_KEYS.length || !CLAIM_KEYS.every(k => has(c, k))) return null;
  if (c.contractVersion !== OBSERVATION_CONTRACT_VERSION || (c.kind !== 'REAL_NETWORK' && c.kind !== 'SYNTHETIC_RUNTIME') || c.realm !== 'test') return null;
  if (typeof c.keyId !== 'string' || !KEY_ID.test(c.keyId) || typeof c.workloadId !== 'string' || !TOKEN.test(c.workloadId) || typeof c.businessId !== 'string' || !TOKEN.test(c.businessId)) return null;
  if (typeof c.accountId !== 'string' || !ACCOUNT.test(c.accountId) || (c.methodId !== 'ACCOUNT_RETRIEVE_CURRENT' && c.methodId !== 'INVOICE_RETRIEVE') || typeof c.apiVersion !== 'string' || c.apiVersion.length > 64) return null;
  if (typeof c.subject !== 'string' || !(c.methodId === 'INVOICE_RETRIEVE' ? INVOICE_ID.test(c.subject) : c.subject === c.accountId)) return null;
  if (typeof c.requestId !== 'string' || !REQUEST_ID.test(c.requestId) || !isInt(c.observedAtMs) || typeof c.authorizationId !== 'string' || !TOKEN.test(c.authorizationId) || !isInt(c.authorizationVersion) || c.authorizationVersion < 1) return null;
  if (typeof c.fingerprint !== 'string' || !DIGEST.test(c.fingerprint)) return null;
  return c as unknown as ObservationClaims;
}

// ---- the runtime ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type RuntimeDenial = KeyDenial | 'INVALID_REQUEST' | 'UNSUPPORTED_API_VERSION' | 'SIGNING_FAILED' | GateDenial | CredentialDenial;
export type RuntimeReadResult =
  | Readonly<{ ok: true; observation: SignedObservation }>
  | Readonly<{ ok: false; kind: 'DENIED'; reason: RuntimeDenial }>
  | Readonly<{ ok: false; kind: 'PROVIDER_FAILURE'; failureClass: FailureClass }>;
export interface RuntimeReadRequest { readonly businessId: string; readonly accountId: string; readonly methodId: ReadMethodId; readonly invoiceId?: string; readonly apiVersion: string; readonly purpose: GatePurpose }

export interface TrustedReadRuntime {
  readonly kind: ObservationKind;
  readonly workloadId: string;
  /** The mapping state the runtime's gate evaluates; read-only. */
  readonly mapping: MappingRegistry;
  /** The authorization, mapping and signing-authority checks for one read, WITHOUT any provider call. */
  check(q: Omit<RuntimeReadRequest, 'invoiceId'>): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; reason: RuntimeDenial }>>;
  /** Authorization is rechecked here, immediately before the one request this call makes. */
  read(req: RuntimeReadRequest): Promise<RuntimeReadResult>;
}

export interface RuntimeParts { readonly signer: RuntimeSigner; readonly keyRing: KeyRingSource; readonly gate: ReadGate; readonly clock: () => number }

/** Shared implementation behind the real and the synthetic runtime. Not part of the package index: the kind is fixed by which factory the caller used, never by an argument. */
export function makeRuntime(kind: ObservationKind, transport: StripeReadTransport, p: RuntimeParts): TrustedReadRuntime {
  if (!p || !p.signer || typeof p.signer.sign !== 'function' || !KEY_ID.test(String(p.signer.keyId)) || typeof p.keyRing !== 'function' || !p.gate || typeof p.clock !== 'function') throw new StripeReadConfigError('CREDENTIAL_SOURCE_INVALID');
  const purpose = KIND_PURPOSE[kind];
  const preflight = async (q: Omit<RuntimeReadRequest, 'invoiceId'>) => {
    if (!q || typeof q.businessId !== 'string' || !ACCOUNT.test(String(q.accountId)) || (q.methodId !== 'ACCOUNT_RETRIEVE_CURRENT' && q.methodId !== 'INVOICE_RETRIEVE')) return { ok: false, reason: 'INVALID_REQUEST' } as const;
    if (typeof q.apiVersion !== 'string' || profileFor(q.apiVersion) === null) return { ok: false, reason: 'UNSUPPORTED_API_VERSION' } as const;
    const nowMs = p.clock();
    const k = await keyEntry(p.keyRing, p.signer.keyId, purpose, nowMs); // the signing authority must be valid BEFORE any request is made
    if (!k.ok) return { ok: false, reason: k.reason } as const;
    const g = await checkRead(p.gate, { businessId: q.businessId, accountId: q.accountId, methodId: q.methodId, apiVersion: q.apiVersion, purpose: q.purpose }, nowMs);
    return g.ok ? ({ ok: true, authorizationId: g.authorizationId, authorizationVersion: g.authorizationVersion } as const) : ({ ok: false, reason: g.reason } as const);
  };
  const runtime: TrustedReadRuntime = {
    kind, workloadId: p.gate.workloadId, mapping: p.gate.mapping,
    async check(q) { const r = await preflight(q); return r.ok ? { ok: true } : { ok: false, reason: r.reason }; },
    async read(req) {
      const pre = await preflight(req);
      if (!pre.ok) return { ok: false, kind: 'DENIED', reason: pre.reason };
      const method = req.methodId as PerformableMethod;
      if (method === 'INVOICE_RETRIEVE' && !(typeof req.invoiceId === 'string' && INVOICE_ID.test(req.invoiceId))) return { ok: false, kind: 'DENIED', reason: 'INVALID_REQUEST' };
      let body: unknown;
      try { body = await transport.get(method, method === 'INVOICE_RETRIEVE' ? { invoiceId: req.invoiceId as string } : undefined, { accountId: req.accountId, workloadId: p.gate.workloadId }); }
      catch (e) {
        if (e instanceof CredentialDenied) return { ok: false, kind: 'DENIED', reason: e.code };
        return { ok: false, kind: 'PROVIDER_FAILURE', failureClass: e instanceof ProviderReadError ? e.failureClass : 'NETWORK' };
      }
      try {
        const frozenBody = JSON.parse(JSON.stringify(body ?? null)) as unknown; // a private copy: the signed body can never be mutated through the provider's object
        const claims: ObservationClaims = {
          contractVersion: OBSERVATION_CONTRACT_VERSION, kind, keyId: p.signer.keyId, workloadId: p.gate.workloadId, businessId: req.businessId, accountId: req.accountId, realm: 'test', methodId: method,
          apiVersion: req.apiVersion, subject: method === 'INVOICE_RETRIEVE' ? (req.invoiceId as string) : req.accountId, requestId: crypto.randomUUID(), observedAtMs: p.clock(),
          authorizationId: pre.authorizationId, authorizationVersion: pre.authorizationVersion, fingerprint: await sha256Hex(canonicalJson(frozenBody)),
        };
        const signature = toHex(await p.signer.sign(observationMessage(claims)));
        if (!SIGNATURE_HEX.test(signature)) return { ok: false, kind: 'DENIED', reason: 'SIGNING_FAILED' };
        const observation: SignedObservation = Object.freeze({ claims: Object.freeze(claims), body: frozenBody, signature });
        issued.add(observation);
        return { ok: true, observation };
      } catch { return { ok: false, kind: 'DENIED', reason: 'SIGNING_FAILED' }; }
    },
  };
  return Object.freeze(runtime);
}

/**
 * The REAL trusted runtime: requests go over the platform `fetch` through a bound, expiring credential source, behind the durable authorization and the mapping gate, and are signed by the trusted
 * runtime key. There is deliberately no `transport`, `fetchImpl` or response argument.
 */
export function createTrustedStripeRuntime(deps: Readonly<{ signer: RuntimeSigner; keyRing: KeyRingSource; gate: ReadGate; credentials: CredentialSource; clock: () => number; timeoutMs?: number; maxBytes?: number }>): TrustedReadRuntime {
  if (!deps || !deps.credentials) throw new StripeReadConfigError('CREDENTIAL_SOURCE_INVALID');
  const transport = createStripeGetTransport({ credentials: deps.credentials, clock: deps.clock, ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}), ...(deps.maxBytes !== undefined ? { maxBytes: deps.maxBytes } : {}) });
  return makeRuntime('REAL_NETWORK', transport, deps);
}

// ---- the verifier ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type ObservationDenial =
  | KeyDenial | 'NOT_ISSUED_BY_RUNTIME' | 'MALFORMED_OBSERVATION' | 'KIND_MISMATCH' | 'SIGNATURE_INVALID' | 'FINGERPRINT_MISMATCH' | 'OBSERVED_IN_FUTURE' | 'OBSERVED_OUTSIDE_KEY_WINDOW'
  | 'BINDING_BUSINESS' | 'BINDING_ACCOUNT' | 'BINDING_WORKLOAD' | 'BINDING_METHOD' | 'BINDING_SUBJECT' | 'BINDING_API_VERSION' | 'BINDING_REALM';
export interface ExpectedBinding { readonly kind: ObservationKind; readonly businessId: string; readonly accountId: string; readonly workloadId: string; readonly methodId: PerformableMethod; readonly subject: string; readonly apiVersion: string }
export type VerifiedObservation = Readonly<{ ok: true; claims: ObservationClaims; body: unknown; kind: ObservationKind }> | Readonly<{ ok: false; reason: ObservationDenial }>;
export interface ObservationVerifier { verify(observation: unknown, expected: ExpectedBinding): Promise<VerifiedObservation> }

/**
 * `crossProcess: true` models a verifier in ANOTHER process that cannot see this process's issued-object identity: it checks the signature and every binding alone. The default (false) additionally
 * requires that the object was issued by a runtime in this process, so a clone, a relabelled copy or a substituted object is refused before its content is considered.
 */
export function createObservationVerifier(deps: Readonly<{ keyRing: KeyRingSource; clock: () => number; crossProcess?: boolean }>): ObservationVerifier {
  if (!deps || typeof deps.keyRing !== 'function' || typeof deps.clock !== 'function') throw new StripeReadConfigError('CREDENTIAL_SOURCE_INVALID');
  return Object.freeze({
    async verify(observation: unknown, expected: ExpectedBinding): Promise<VerifiedObservation> {
      const deny = (reason: ObservationDenial): VerifiedObservation => ({ ok: false, reason });
      if (observation === null || typeof observation !== 'object') return deny('MALFORMED_OBSERVATION');
      if (!deps.crossProcess && !issued.has(observation)) return deny('NOT_ISSUED_BY_RUNTIME');
      const o = observation as { claims?: unknown; body?: unknown; signature?: unknown };
      const claims = parseClaims(o.claims);
      if (!claims || typeof o.signature !== 'string' || !SIGNATURE_HEX.test(o.signature)) return deny('MALFORMED_OBSERVATION');
      if (!expected || (expected.kind !== 'REAL_NETWORK' && expected.kind !== 'SYNTHETIC_RUNTIME') || claims.kind !== expected.kind) return deny('KIND_MISMATCH');
      const nowMs = deps.clock();
      const k = await keyEntry(deps.keyRing, claims.keyId, KIND_PURPOSE[expected.kind], nowMs, 'VERIFY');
      if (!k.ok) return deny(k.reason);
      let verified = false;
      try {
        const key = await crypto.subtle.importKey('raw', fromHex(k.entry.publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
        verified = await crypto.subtle.verify({ name: 'Ed25519' }, key, fromHex(o.signature), observationMessage(claims));
      } catch { verified = false; }
      if (!verified) return deny('SIGNATURE_INVALID');
      if (claims.fingerprint !== await sha256Hex(canonicalJson(o.body))) return deny('FINGERPRINT_MISMATCH');
      if (claims.observedAtMs > nowMs) return deny('OBSERVED_IN_FUTURE');
      if (claims.observedAtMs < k.entry.notBeforeMs || claims.observedAtMs >= k.entry.notAfterMs) return deny('OBSERVED_OUTSIDE_KEY_WINDOW');
      if (claims.businessId !== expected.businessId) return deny('BINDING_BUSINESS');
      if (claims.accountId !== expected.accountId) return deny('BINDING_ACCOUNT');
      if (claims.workloadId !== expected.workloadId) return deny('BINDING_WORKLOAD');
      if (claims.methodId !== expected.methodId) return deny('BINDING_METHOD');
      if (claims.subject !== expected.subject) return deny('BINDING_SUBJECT');
      if (claims.apiVersion !== expected.apiVersion) return deny('BINDING_API_VERSION');
      return { ok: true, claims, body: o.body, kind: claims.kind };
    },
  });
}

/** True only for an object this module's runtime issued in this process. */
export const isIssuedObservation = (x: unknown): x is SignedObservation => x !== null && typeof x === 'object' && issued.has(x);
