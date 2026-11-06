import type { WorkloadEnvironment } from './workload-identity';

/**
 * S08-D1D3-DEV-14: SIGNING-KEY CONFIGURATION CONTRACT for cryptographically authenticated evidence. It extends the DEV-11 custody foundations with an explicit algorithm allowlist, purpose and environment separation,
 * lifecycle states (PENDING / ACTIVE / RETIRED / REVOKED), versions for rotation, and an explicit verification policy.
 *
 * The directory lists PUBLIC key records only, and comes from trusted runtime configuration. Private key material lives behind `EvidenceSignerProvider` (a capability that signs and can never return the key), is
 * never stored in an application table, and appears in no result, error or log from this module. A record with any missing, extra, malformed or inconsistent field makes the WHOLE directory untrusted (fail closed):
 * an ambiguous key state is never interpreted generously. Production custody and creation of real keys are owner decisions; the production adapters below are deliberately unprovisioned.
 */
export type EvidenceSigningPurpose = 'STRIPE_OBSERVATION_ATTESTATION' | 'SYNTHETIC_TEST_EVIDENCE';
export const EVIDENCE_SIGNING_PURPOSES: readonly EvidenceSigningPurpose[] = ['STRIPE_OBSERVATION_ATTESTATION', 'SYNTHETIC_TEST_EVIDENCE'];
/** Evidence types each purpose may sign. A signature for one purpose or type can never verify as another. */
export const PURPOSE_EVIDENCE_TYPES: Readonly<Record<EvidenceSigningPurpose, readonly string[]>> = Object.freeze({
  STRIPE_OBSERVATION_ATTESTATION: Object.freeze(['STRIPE_ACCOUNT_OBSERVATION', 'STRIPE_INVOICE_OBSERVATION']),
  SYNTHETIC_TEST_EVIDENCE: Object.freeze(['SYNTHETIC_TEST_EVIDENCE']),
});
export const SIGNING_ALGORITHMS = ['Ed25519'] as const;
export type SigningAlgorithm = typeof SIGNING_ALGORITHMS[number];
export type KeyLifecycleState = 'PENDING' | 'ACTIVE' | 'RETIRED' | 'REVOKED';
export const KEY_ENVIRONMENTS: readonly WorkloadEnvironment[] = ['development', 'staging', 'production'];

export const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
export const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
/** Synthetic evidence can never exist in production: neither a key nor a workload may carry it there. */
export const purposeAllowedIn = (purpose: EvidenceSigningPurpose, env: WorkloadEnvironment): boolean => !(purpose === 'SYNTHETIC_TEST_EVIDENCE' && env === 'production');

export interface EvidenceKeyRecord {
  readonly keyId: string; readonly version: number; readonly algorithm: SigningAlgorithm; readonly purpose: EvidenceSigningPurpose; readonly environment: WorkloadEnvironment;
  readonly state: KeyLifecycleState; readonly publicKeyHex: string;
  /** Issuance window: new signatures are made only inside it, only by an ACTIVE key. */
  readonly notBeforeMs: number; readonly notAfterMs: number;
  /** Retained-verification deadline: the latest time a RETIRED key may still verify historical evidence, if (and only if) the verification policy accepts retired keys. */
  readonly verifyUntilMs: number;
  readonly retiredAtMs: number | null; readonly revokedAtMs: number | null;
}
export interface EvidenceKeyDirectory { load(): Promise<unknown> }
/** The trusted signing boundary. Returns a signing capability for a key id, or null. Implementations hold the private key; this interface cannot return it. */
export interface EvidenceSigner { readonly keyId: string; sign(message: Uint8Array): Promise<Uint8Array> }
export interface EvidenceSignerProvider { signerFor(keyId: string): EvidenceSigner | null }

/**
 * The explicit verification policy for non-ACTIVE keys. REVOKED keys verify nothing under every policy (a compromised key's signatures cannot be told apart from forgeries). RETIRED keys (and ACTIVE keys past
 * their issuance window) verify historical evidence only when the policy says so, and only until `verifyUntilMs`. Anything other than the exact accepting policy object is the default: REJECT.
 */
export type VerificationPolicy = Readonly<{ retiredKeys: 'REJECT' | 'ACCEPT_WITHIN_RETENTION' }>;
export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = Object.freeze({ retiredKeys: 'REJECT' });
export function resolveVerificationPolicy(p: unknown): VerificationPolicy {
  if (p !== null && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 1 && (p as Record<string, unknown>).retiredKeys === 'ACCEPT_WITHIN_RETENTION') return Object.freeze({ retiredKeys: 'ACCEPT_WITHIN_RETENTION' });
  return DEFAULT_VERIFICATION_POLICY; // missing, unknown or ambiguous: reject evidence that depends on a retired key
}

const RECORD_KEYS = ['keyId', 'version', 'algorithm', 'purpose', 'environment', 'state', 'publicKeyHex', 'notBeforeMs', 'notAfterMs', 'verifyUntilMs', 'retiredAtMs', 'revokedAtMs'];
export function parseKeyDirectory(raw: unknown): EvidenceKeyRecord[] | null {
  if (!Array.isArray(raw) || raw.length > 64) return null;
  const out: EvidenceKeyRecord[] = []; const ids = new Set<string>(); const versions = new Set<string>();
  for (const x of raw) {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) return null;
    const r = x as Record<string, unknown>;
    if (Object.keys(r).length !== RECORD_KEYS.length || !RECORD_KEYS.every(k => has(r, k))) return null;
    if (typeof r.keyId !== 'string' || !KEY_ID.test(r.keyId) || ids.has(r.keyId) || !isInt(r.version) || r.version < 1) return null;
    if (!(SIGNING_ALGORITHMS as readonly unknown[]).includes(r.algorithm)) return null;
    if (!(EVIDENCE_SIGNING_PURPOSES as readonly unknown[]).includes(r.purpose) || !(KEY_ENVIRONMENTS as readonly unknown[]).includes(r.environment)) return null;
    if (!purposeAllowedIn(r.purpose as EvidenceSigningPurpose, r.environment as WorkloadEnvironment)) return null;
    if (typeof r.publicKeyHex !== 'string' || !PUBLIC_KEY_HEX.test(r.publicKeyHex)) return null;
    if (!isInt(r.notBeforeMs) || !isInt(r.notAfterMs) || r.notAfterMs <= r.notBeforeMs || !isInt(r.verifyUntilMs) || r.verifyUntilMs < r.notAfterMs) return null;
    if ((r.retiredAtMs !== null && !isInt(r.retiredAtMs)) || (r.revokedAtMs !== null && !isInt(r.revokedAtMs))) return null;
    // the lifecycle state must agree with its timestamps: a contradictory record is ambiguous and untrusted
    const retired = r.retiredAtMs !== null; const revoked = r.revokedAtMs !== null;
    if (r.state === 'PENDING' || r.state === 'ACTIVE') { if (retired || revoked) return null; }
    else if (r.state === 'RETIRED') { if (!retired || revoked) return null; }
    else if (r.state === 'REVOKED') { if (!revoked) return null; }
    else return null;
    const vk = `${r.purpose}|${r.environment}|${r.version}`; // a version identifies one key per purpose and environment
    if (versions.has(vk)) return null;
    ids.add(r.keyId); versions.add(vk); out.push(r as unknown as EvidenceKeyRecord);
  }
  return out;
}

/** The production directory adapter: DISABLED. Real key custody has not been provisioned (an owner decision), so every load fails closed and nothing signs or verifies. */
export function createUnprovisionedKeyDirectory(): EvidenceKeyDirectory { return Object.freeze({ load: () => Promise.reject(new Error('KEY_DIRECTORY_NOT_PROVISIONED')) }); }
/** The production signer adapter: DISABLED. It holds no key and can sign nothing. */
export function createUnprovisionedSignerProvider(): EvidenceSignerProvider { return Object.freeze({ signerFor: () => null }); }
