import type { KeyPurpose, KeyRingSource, RuntimeSigner, TrustedKeyRing } from './trusted-runtime';

/**
 * S08-D1D3-DEV-11: SIGNING-KEY CUSTODY interface, extending the DEV-05 recorder-key and DEV-10 observation-key foundations. The directory (trusted configuration) lists PUBLIC key records: id, version, purpose,
 * public key, an issuance window, a retained-verification deadline and a revocation mark. The signer provider holds the private material inside the trusted signing boundary and returns signing capabilities
 * only: nothing in this module, its results or its errors carries private key bytes, and an imported key is non-extractable.
 *
 *  - ISSUANCE: `activeSigner(purpose)` selects the newest VALID version for that purpose (inside its issuance window, not revoked) and returns a signer that re-checks the directory on EVERY sign, so a key revoked or
 *    expired after selection signs nothing further. An unknown or wrong-purpose key is never selected.
 *  - VERIFICATION: `keyRing` is what verifiers use. Historical evidence verifies until the record's explicit `verifyUntilMs` (the retained-key policy); a revoked key verifies nothing; an unknown key id is absent
 *    (rejected); purposes are carried so a SYNTHETIC key can never verify as REAL_NETWORK evidence.
 *  - ROTATION: several versions may be live at once; each has its own key id, so old observations keep verifying through the retention window while new ones use the newest key.
 * Production key custody and creation are separate owner decisions; tests use generated, disposable keys only.
 */
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

export interface SigningKeyRecord { readonly keyId: string; readonly version: number; readonly purpose: KeyPurpose; readonly publicKeyHex: string; readonly notBeforeMs: number; readonly notAfterMs: number; readonly verifyUntilMs: number; readonly revokedAtMs: number | null }
export interface SigningKeyDirectory { load(): Promise<unknown> }
/** The trusted signing boundary. Returns a signing capability for a key id, or null. Implementations hold the private key; this interface cannot return it. */
export interface SignerProvider { signerFor(keyId: string): RuntimeSigner | null }
export class SigningCustodyError extends Error {
  constructor(readonly code: 'DIRECTORY_UNAVAILABLE' | 'NO_VALID_KEY' | 'SIGNER_UNAVAILABLE' | 'KEY_NOT_USABLE') { super(`SIGNING_CUSTODY_${code}`); this.name = 'SigningCustodyError'; }
}

function parseDirectory(raw: unknown): SigningKeyRecord[] | null {
  if (!Array.isArray(raw) || raw.length > 64) return null;
  const out: SigningKeyRecord[] = []; const ids = new Set<string>();
  for (const x of raw) {
    if (x === null || typeof x !== 'object') return null;
    const r = x as Record<string, unknown>;
    const keys = ['keyId', 'version', 'purpose', 'publicKeyHex', 'notBeforeMs', 'notAfterMs', 'verifyUntilMs', 'revokedAtMs'];
    if (Object.keys(r).length !== keys.length || !keys.every(k => has(r, k))) return null;
    if (typeof r.keyId !== 'string' || !KEY_ID.test(r.keyId) || ids.has(r.keyId) || !isInt(r.version) || r.version < 1 || (r.purpose !== 'TRUSTED_RUNTIME' && r.purpose !== 'SYNTHETIC_RUNTIME')) return null;
    if (typeof r.publicKeyHex !== 'string' || !PUBLIC_KEY_HEX.test(r.publicKeyHex) || !isInt(r.notBeforeMs) || !isInt(r.notAfterMs) || r.notAfterMs <= r.notBeforeMs || !isInt(r.verifyUntilMs) || r.verifyUntilMs < r.notAfterMs) return null;
    if (r.revokedAtMs !== null && !isInt(r.revokedAtMs)) return null;
    ids.add(r.keyId); out.push(r as unknown as SigningKeyRecord);
  }
  return out;
}

export interface SigningCustody {
  /** Verification key ring (public keys, retained-key policy, purposes). An unavailable or malformed directory yields no keys, which rejects everything. */
  readonly keyRing: KeyRingSource;
  /** The signer for the newest valid key of this purpose. Throws SigningCustodyError when none is valid or the provider has no signer for it. */
  activeSigner(purpose: KeyPurpose): Promise<RuntimeSigner>;
}

export function createSigningCustody(deps: Readonly<{ directory: SigningKeyDirectory; signers: SignerProvider; clock: () => number }>): SigningCustody {
  const load = async (): Promise<SigningKeyRecord[]> => {
    let raw: unknown;
    try { raw = await deps.directory.load(); } catch { throw new SigningCustodyError('DIRECTORY_UNAVAILABLE'); }
    const d = parseDirectory(raw);
    if (!d) throw new SigningCustodyError('DIRECTORY_UNAVAILABLE'); // one malformed record makes the whole directory untrusted
    return d;
  };
  const usable = (k: SigningKeyRecord, purpose: KeyPurpose, nowMs: number) => k.purpose === purpose && k.revokedAtMs === null && k.notBeforeMs <= nowMs && nowMs < k.notAfterMs;
  return Object.freeze({
    keyRing: async (): Promise<TrustedKeyRing> => {
      const ring = Object.setPrototypeOf({}, null) as Record<string, TrustedKeyRing[string]>;
      for (const k of await load()) ring[k.keyId] = { publicKeyHex: k.publicKeyHex, purpose: k.purpose, notBeforeMs: k.notBeforeMs, notAfterMs: k.notAfterMs, verifyUntilMs: k.verifyUntilMs, revokedAtMs: k.revokedAtMs };
      return Object.freeze(ring);
    },
    async activeSigner(purpose: KeyPurpose): Promise<RuntimeSigner> {
      const nowMs = deps.clock();
      const best = (await load()).filter(k => usable(k, purpose, nowMs)).sort((a, b) => b.version - a.version)[0];
      if (!best) throw new SigningCustodyError('NO_VALID_KEY');
      const inner = deps.signers.signerFor(best.keyId);
      if (!inner || inner.keyId !== best.keyId || typeof inner.sign !== 'function') throw new SigningCustodyError('SIGNER_UNAVAILABLE');
      return Object.freeze({
        keyId: best.keyId,
        async sign(message: Uint8Array): Promise<Uint8Array> {
          const current = (await load()).find(k => k.keyId === best.keyId); // re-checked on every signature: revoked or expired after selection means no more proofs
          if (!current || !usable(current, purpose, deps.clock())) throw new SigningCustodyError('KEY_NOT_USABLE');
          return inner.sign(message);
        },
      });
    },
  });
}
