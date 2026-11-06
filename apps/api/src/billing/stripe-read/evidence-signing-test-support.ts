import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createRuntimeSigner } from './trusted-runtime';
import type { EvidenceKeyDirectory, EvidenceKeyRecord, EvidenceSigner, EvidenceSignerProvider, EvidenceSigningPurpose, KeyLifecycleState } from './evidence-signing-keys';
import type { WorkloadConfigSource, WorkloadEnvironment } from './workload-identity';

/**
 * S08-D1D3-DEV-14 TEST-ONLY identity and key provider. NOT exported from the package index and never imported by production code (a static test enforces both). It generates DISPOSABLE Ed25519 keys in memory
 * (the private half is held only by a non-extractable signer), and its workload source refuses to be built for the production environment.
 */
export interface SyntheticKey { readonly record: EvidenceKeyRecord; readonly signer: EvidenceSigner; /** test-only: the PKCS#8 text, so tests can prove it never leaks */ readonly pkcs8Base64: string }
export async function syntheticKey(over: Partial<EvidenceKeyRecord> & { keyId: string }): Promise<SyntheticKey> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pkcs8Base64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyHex = spki.subarray(spki.length - 32).toString('hex');
  const purpose: EvidenceSigningPurpose = over.purpose ?? 'SYNTHETIC_TEST_EVIDENCE';
  const record: EvidenceKeyRecord = {
    version: 1, algorithm: 'Ed25519', purpose, environment: 'development', state: 'ACTIVE' as KeyLifecycleState, publicKeyHex, notBeforeMs: 1_000, notAfterMs: 1_000_000, verifyUntilMs: 2_000_000,
    retiredAtMs: null, revokedAtMs: null, ...over,
  };
  return { record, signer: await createRuntimeSigner(record.keyId, pkcs8Base64), pkcs8Base64 };
}
export function syntheticDirectory(source: () => unknown): EvidenceKeyDirectory { return { load: async () => source() }; }
export function syntheticSignerProvider(keys: readonly SyntheticKey[]): EvidenceSignerProvider {
  return { signerFor: (id: string) => keys.find(k => k.record.keyId === id)?.signer ?? null };
}
export function syntheticSigningWorkloadSource(environment: WorkloadEnvironment, source: () => unknown): WorkloadConfigSource {
  if (environment === 'production') throw new Error('TEST_IDENTITY_PROVIDER_REFUSED_IN_PRODUCTION');
  return { load: async () => source() };
}
export const randomBusinessId = (): string => { const b = randomBytes(16); b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80; const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
