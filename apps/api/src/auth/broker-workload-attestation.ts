/**
 * Gate 2 B4-09: development-only independent workload attestation prototype.
 * Cryptographic provenance is NOT authorization. Not mounted on any Worker.
 *
 * A distinct Ed25519 key signs the exact B4-03 assertion wire message and
 * signature. Its verifier is provided by an independently trusted key source;
 * caller-supplied keys/verification flags are never supported.
 */
import {
  brokerAssertionMessage, brokerHex, validBrokerKey,
  verifyBrokerAssertionSignature,
  type BrokerAssertion, type BrokerKeySource,
} from './broker-assertion.contract';

export interface B409WorkloadEvidence {
  readonly version: 'B4-09/1';
  readonly environment: 'development';
  readonly workload: 'echogrid:development:api-worker';
  readonly audience: 'echogrid:development:isolated-broker';
  readonly keyId: string;
  readonly keyVersion: number;
  readonly assertionDigest: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly signature: string;
}

export interface B409Invocation {
  readonly assertion: BrokerAssertion;
  readonly workloadEvidence: B409WorkloadEvidence;
}

export interface B409Result {
  readonly provenanceVerified: boolean;
  readonly brokerAuthorization: 'NOT_GRANTED';
  readonly deploymentAuthorized: false;
  readonly reason: 'VERIFIED_PROVENANCE_ONLY' | 'UNTRUSTED_INVOCATION';
}

const fields = [
  'version', 'environment', 'workload', 'audience', 'keyId', 'keyVersion',
  'assertionDigest', 'issuedAt', 'expiresAt',
] as const;
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const hexBytes = (v: string): Uint8Array => Uint8Array.from(v.match(/../g)!, b => Number.parseInt(b, 16));

/** Canonical byte-length prefixed B4-09/1 message. No JSON canonicalization. */
export function b409WorkloadMessage(e: B409WorkloadEvidence): Uint8Array {
  const encoder = new TextEncoder();
  const parts = ['ECHO-GRID:WORKLOAD-ATTESTATION:B4-09/1', ...fields.map(f => String(e[f]))];
  return encoder.encode(parts.map(s => `${encoder.encode(s).length}:${s};`).join(''));
}

export async function b409AssertionDigest(assertion: BrokerAssertion): Promise<string> {
  const claims = brokerAssertionMessage(assertion.claims);
  const signature = hexBytes(assertion.signature);
  const exact = new Uint8Array(claims.length + signature.length);
  exact.set(claims);
  exact.set(signature, claims.length);
  const digest = await crypto.subtle.digest('SHA-256', exact);
  return brokerHex(new Uint8Array(digest));
}

/**
 * Two independently sourced public-key verifications. A valid result only
 * establishes cryptographic provenance; it does NOT establish workload key
 * custody, transport isolation, actor/session rights, nonce consumption,
 * revocation synchronization, restricted SQL role or deployment approval.
 */
export async function verifyB409Invocation(
  raw: unknown,
  assertionKeys: BrokerKeySource,
  workloadKeys: BrokerKeySource,
  now: number,
): Promise<B409Result> {
  const denied: B409Result = { provenanceVerified: false, brokerAuthorization: 'NOT_GRANTED',
    deploymentAuthorized: false, reason: 'UNTRUSTED_INVOCATION' };
  try {
    if (!integer(now) || !raw || typeof raw !== 'object' || Array.isArray(raw) ||
        Object.keys(raw).sort().join(',') !== 'assertion,workloadEvidence') return denied;
    const invocation = raw as B409Invocation;
    const e = invocation.workloadEvidence;
    if (!e || typeof e !== 'object' || Array.isArray(e) ||
        Object.keys(e).sort().join(',') !== [...fields, 'signature'].sort().join(',') ||
        e.version !== 'B4-09/1' || e.environment !== 'development' ||
        e.workload !== 'echogrid:development:api-worker' ||
        e.audience !== 'echogrid:development:isolated-broker' ||
        typeof e.keyId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(e.keyId) ||
        !integer(e.keyVersion) || e.keyVersion < 1 ||
        !integer(e.issuedAt) || !integer(e.expiresAt) ||
        e.issuedAt > now || e.expiresAt <= now ||
        e.expiresAt - e.issuedAt > 30 ||
        typeof e.assertionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(e.assertionDigest) ||
        typeof e.signature !== 'string' || !/^[0-9a-f]{128}$/.test(e.signature)) return denied;
    if (!(await verifyBrokerAssertionSignature(invocation.assertion, assertionKeys, now))) return denied;
    if ((await b409AssertionDigest(invocation.assertion)) !== e.assertionDigest) return denied;
    const key = await workloadKeys();
    if (!validBrokerKey(key, now) || key.keyId !== e.keyId || key.version !== e.keyVersion ||
        e.issuedAt < key.notBefore || e.expiresAt > key.notAfter) return denied;
    const imported = await crypto.subtle.importKey('raw', hexBytes(key.publicKeyHex), 'Ed25519', false, ['verify']);
    const verified = await crypto.subtle.verify('Ed25519', imported, hexBytes(e.signature), b409WorkloadMessage(e));
    if (!verified) return denied;
    return { provenanceVerified: true, brokerAuthorization: 'NOT_GRANTED',
      deploymentAuthorized: false, reason: 'VERIFIED_PROVENANCE_ONLY' };
  } catch {
    return denied;
  }
}
