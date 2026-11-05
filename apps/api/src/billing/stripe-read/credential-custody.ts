import { CredentialDenied, type CredentialRecord, type CredentialSource } from './transport';
import { isTrustedWorkloadIdentity, type TrustedWorkloadIdentity, type WorkloadAuthority } from './workload-identity';

/**
 * S08-D1D3-DEV-11: CREDENTIAL PROVISIONING interfaces (development-safe). Five concerns are separate: the credential REFERENCE (an opaque `cred:` name, never a secret), the descriptor (account, workload,
 * mode, versions, revocation), the SECRET PROVIDER (returns a value for a reference and version; a fake in tests, the real store is a separate owner authorization), validation (test-mode only, shape, expiry,
 * revocation) and the workload binding.
 *
 * Only a TRUSTED WORKLOAD can obtain a `CredentialSource`: `sourceFor` requires a genuine `TrustedWorkloadIdentity` and re-checks the workload authority (environment, account, realm, method scope, expiry,
 * revocation) on EVERY resolve, before the secret provider is called, so a workload that is not authorized never causes a secret read, and a failed resolution never causes a provider request (the transport
 * resolves first). Rotation: several versions may be valid at once; the newest valid version wins and an older valid one is the fallback during the overlap. Revocation (of the credential or one version)
 * stops all further use. The value lives only in the returned record handed to the transport; it is in no audit event, error or return value of this module's own API.
 */
const REF = /^cred:[a-z0-9][a-z0-9._-]{0,63}$/;
const TEST_KEY = /^(rk|sk)_test_[A-Za-z0-9]{8,}$/;
const ACCOUNT = /^acct_[A-Za-z0-9]{1,128}$/;
const WORKLOAD_ID = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$/;
const VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

export interface CredentialVersion { readonly version: string; readonly notBeforeMs: number; readonly notAfterMs: number; readonly revokedAtMs: number | null }
export interface CredentialDescriptor { readonly ref: string; readonly workloadId: string; readonly accountId: string; readonly mode: 'test'; readonly revokedAtMs: number | null; readonly versions: readonly CredentialVersion[] }
/** Returns the secret for a reference and version, or null. Implemented by a secret store; the value never leaves this boundary except into the transport. */
export interface SecretProvider { read(ref: string, version: string): Promise<string | null> }
export interface CredentialDescriptorSource { load(ref: string): Promise<unknown> }
export type CredentialAuditEvent = Readonly<{ event: 'credential.resolved' | 'credential.denied'; ref: string; workloadId: string; accountId: string; version: string | null; reason: string | null; atMs: number }>;
export class CredentialCustodyError extends Error { constructor(readonly code: 'NOT_A_TRUSTED_WORKLOAD' | 'CUSTODY_UNCONFIGURED') { super(`CREDENTIAL_CUSTODY_${code}`); this.name = 'CredentialCustodyError'; } }

function parseDescriptor(raw: unknown): CredentialDescriptor | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keys = ['ref', 'workloadId', 'accountId', 'mode', 'revokedAtMs', 'versions'];
  if (Object.keys(r).length !== keys.length || !keys.every(k => has(r, k))) return null;
  if (typeof r.ref !== 'string' || !REF.test(r.ref) || /(rk|sk)_(test|live)/i.test(r.ref) || typeof r.workloadId !== 'string' || !WORKLOAD_ID.test(r.workloadId) || typeof r.accountId !== 'string' || !ACCOUNT.test(r.accountId) || r.mode !== 'test') return null;
  if (r.revokedAtMs !== null && !isInt(r.revokedAtMs)) return null;
  if (!Array.isArray(r.versions) || r.versions.length === 0 || r.versions.length > 8) return null;
  const seen = new Set<string>();
  for (const v of r.versions) {
    if (v === null || typeof v !== 'object') return null;
    const x = v as Record<string, unknown>;
    if (Object.keys(x).length !== 4 || typeof x.version !== 'string' || !VERSION.test(x.version) || seen.has(x.version) || !isInt(x.notBeforeMs) || !isInt(x.notAfterMs) || x.notAfterMs <= x.notBeforeMs || (x.revokedAtMs !== null && !isInt(x.revokedAtMs))) return null;
    seen.add(x.version);
  }
  return r as unknown as CredentialDescriptor;
}

export interface CredentialCustody { sourceFor(identity: TrustedWorkloadIdentity): CredentialSource }

export function createCredentialCustody(deps: Readonly<{ descriptors: CredentialDescriptorSource; secrets: SecretProvider; workloads: WorkloadAuthority; clock: () => number; audit?: (e: CredentialAuditEvent) => void }>): CredentialCustody {
  if (!deps || !deps.descriptors || typeof deps.descriptors.load !== 'function' || !deps.secrets || typeof deps.secrets.read !== 'function' || !deps.workloads || typeof deps.clock !== 'function') throw new CredentialCustodyError('CUSTODY_UNCONFIGURED');
  const emit = (e: CredentialAuditEvent) => { try { deps.audit?.(e); } catch { /* an audit failure never changes a decision */ } };
  return Object.freeze({
    sourceFor(identity: TrustedWorkloadIdentity): CredentialSource {
      if (!isTrustedWorkloadIdentity(identity)) throw new CredentialCustodyError('NOT_A_TRUSTED_WORKLOAD');
      return Object.freeze({
        async resolve(binding: Readonly<{ accountId: string; workloadId: string }>): Promise<CredentialRecord | null> {
          const nowMs = deps.clock();
          const fail = (code: ConstructorParameters<typeof CredentialDenied>[0], version: string | null = null): never => {
            emit({ event: 'credential.denied', ref: identity.credentialRef, workloadId: identity.workloadId, accountId: identity.accountId, version, reason: code, atMs: nowMs });
            throw new CredentialDenied(code);
          };
          if (!binding || binding.workloadId !== identity.workloadId) return fail('CREDENTIAL_WORKLOAD_MISMATCH');
          if (binding.accountId !== identity.accountId) return fail('CREDENTIAL_ACCOUNT_MISMATCH');
          // the workload must be authorized FIRST: nothing below (descriptor read, secret read) happens for a workload that is expired, revoked or out of scope
          const w = await deps.workloads.check(identity, { environment: identity.environment, accountId: identity.accountId, realm: identity.realm, methodId: identity.methods[0] ?? '' });
          if (w !== null) return fail('CREDENTIAL_WORKLOAD_NOT_AUTHORIZED');
          let raw: unknown;
          try { raw = await deps.descriptors.load(identity.credentialRef); } catch { return fail('CREDENTIAL_SOURCE_UNAVAILABLE'); }
          if (raw === null || raw === undefined) return fail('CREDENTIAL_MISSING');
          const d = parseDescriptor(raw);
          if (!d || d.ref !== identity.credentialRef) return fail('CREDENTIAL_MALFORMED');
          if (d.workloadId !== identity.workloadId) return fail('CREDENTIAL_WORKLOAD_MISMATCH');
          if (d.accountId !== identity.accountId) return fail('CREDENTIAL_ACCOUNT_MISMATCH');
          if (d.revokedAtMs !== null) return fail('CREDENTIAL_REVOKED');
          const live = d.versions.filter(v => v.revokedAtMs === null);
          if (live.length === 0) return fail('CREDENTIAL_REVOKED');
          const usable = live.filter(v => v.notBeforeMs <= nowMs && nowMs < v.notAfterMs).sort((a, b) => b.notBeforeMs - a.notBeforeMs); // newest first: the rotation overlap prefers the new version
          if (usable.length === 0) return fail(live.every(v => nowMs >= v.notAfterMs) ? 'CREDENTIAL_EXPIRED' : 'CREDENTIAL_MISSING');
          for (const v of usable) {
            let value: string | null;
            try { value = await deps.secrets.read(d.ref, v.version); } catch { return fail('CREDENTIAL_SOURCE_UNAVAILABLE', v.version); }
            if (value === null) continue; // not provisioned for this version: fall back to the previous valid version during the overlap
            if (typeof value !== 'string') return fail('CREDENTIAL_MALFORMED', v.version);
            if (/^(rk|sk)_live_/.test(value)) return fail('CREDENTIAL_LIVE_MODE', v.version);
            if (!TEST_KEY.test(value)) return fail('CREDENTIAL_MALFORMED', v.version);
            emit({ event: 'credential.resolved', ref: d.ref, workloadId: identity.workloadId, accountId: identity.accountId, version: v.version, reason: null, atMs: nowMs });
            return { apiKey: value, accountId: d.accountId, workloadId: d.workloadId, validUntilMs: v.notAfterMs };
          }
          return fail('CREDENTIAL_MISSING');
        },
      });
    },
  });
}
