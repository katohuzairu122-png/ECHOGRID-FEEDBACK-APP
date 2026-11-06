import { EVIDENCE_SIGNING_PURPOSES, KEY_ENVIRONMENTS, PURPOSE_EVIDENCE_TYPES, isInt, purposeAllowedIn, type EvidenceSigningPurpose } from './evidence-signing-keys';
import type { WorkloadConfigSource, WorkloadEnvironment } from './workload-identity';

/**
 * S08-D1D3-DEV-14: the SIGNING WORKLOAD identity. It is deliberately a different type from the DEV-11 read-workload identity: a read workload (which can reach Stripe with a restricted credential) cannot sign
 * evidence, and a signing workload cannot read Stripe. The identity originates ONLY from trusted runtime configuration (`WorkloadConfigSource`, read by the signing workload itself) and is reloaded on every
 * check, so expiry, revocation and environment changes take effect on the next request. `resolve` takes no identity argument: no request, header, body, session or administrator context can name or supply one,
 * and a `SigningWorkloadIdentity` is a frozen, branded, WeakSet-registered object nothing else constructs.
 *
 * It binds the stable workload id, the environment, the permitted signing purposes, an EXPLICIT allowlist of businesses (no wildcard, so tenant authority cannot be substituted), the validity period and the
 * revocation state. The production source below is disabled; provisioning real signing workloads is an owner decision.
 */
declare const BRAND: unique symbol;
const WORKLOAD_ID = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$/;
export const SIGNING_BUSINESS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export interface SigningWorkloadIdentity {
  readonly [BRAND]: true;
  readonly workloadId: string; readonly role: 'EVIDENCE_SIGNER'; readonly environment: WorkloadEnvironment;
  readonly purposes: readonly EvidenceSigningPurpose[]; readonly businessIds: readonly string[]; readonly validFromMs: number; readonly expiresAtMs: number;
}
const minted = new WeakSet<object>();
export const isSigningWorkloadIdentity = (x: unknown): x is SigningWorkloadIdentity => x !== null && typeof x === 'object' && minted.has(x);

export type SigningWorkloadDenial =
  | 'SIGNER_CONFIG_MISSING' | 'SIGNER_CONFIG_UNAVAILABLE' | 'SIGNER_CONFIG_MALFORMED' | 'SIGNER_WRONG_ENVIRONMENT' | 'SIGNER_EXPIRED' | 'SIGNER_NOT_YET_VALID' | 'SIGNER_REVOKED'
  | 'SIGNER_NOT_TRUSTED' | 'SIGNER_PURPOSE_NOT_PERMITTED' | 'SIGNER_EVIDENCE_TYPE_NOT_PERMITTED' | 'SIGNER_TENANT_NOT_PERMITTED';
export type SigningWorkloadResolveResult = Readonly<{ ok: true; identity: SigningWorkloadIdentity }> | Readonly<{ ok: false; reason: SigningWorkloadDenial }>;
export interface SigningUse { readonly environment: string; readonly purpose: string; readonly evidenceType: string; readonly businessId: string }
export interface SigningWorkloadAuthority {
  /** The identity from trusted configuration for the configured environment, or a denial. There is no parameter through which a caller names a workload. */
  resolve(): Promise<SigningWorkloadResolveResult>;
  /** Re-reads the configuration and decides whether this exact identity may sign this exact use NOW. */
  check(identity: unknown, use: SigningUse): Promise<SigningWorkloadDenial | null>;
}

interface Record_ { workloadId: string; role: 'EVIDENCE_SIGNER'; environment: WorkloadEnvironment; purposes: EvidenceSigningPurpose[]; businessIds: string[]; validFromMs: number; expiresAtMs: number; revokedAtMs: number | null }
const RECORD_KEYS = ['workloadId', 'role', 'environment', 'purposes', 'businessIds', 'validFromMs', 'expiresAtMs', 'revokedAtMs'];
function parse(raw: unknown): Record_ | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).length !== RECORD_KEYS.length || !RECORD_KEYS.every(k => has(r, k))) return null;
  if (typeof r.workloadId !== 'string' || !WORKLOAD_ID.test(r.workloadId) || r.role !== 'EVIDENCE_SIGNER') return null;
  if (typeof r.environment !== 'string' || !(KEY_ENVIRONMENTS as readonly string[]).includes(r.environment)) return null;
  if (!Array.isArray(r.purposes) || r.purposes.length === 0 || new Set(r.purposes).size !== r.purposes.length || !r.purposes.every(p => (EVIDENCE_SIGNING_PURPOSES as readonly unknown[]).includes(p) && purposeAllowedIn(p as EvidenceSigningPurpose, r.environment as WorkloadEnvironment))) return null;
  if (!Array.isArray(r.businessIds) || r.businessIds.length === 0 || r.businessIds.length > 64 || new Set(r.businessIds).size !== r.businessIds.length || !r.businessIds.every(b => typeof b === 'string' && SIGNING_BUSINESS_ID.test(b))) return null;
  if (!isInt(r.validFromMs) || !isInt(r.expiresAtMs) || r.expiresAtMs <= r.validFromMs || (r.revokedAtMs !== null && !isInt(r.revokedAtMs))) return null;
  return r as unknown as Record_;
}

export function createSigningWorkloadAuthority(deps: Readonly<{ source: WorkloadConfigSource | null | undefined; environment: WorkloadEnvironment; clock: () => number }>): SigningWorkloadAuthority {
  const load = async (): Promise<{ rec: Record_ } | { reason: SigningWorkloadDenial }> => {
    if (!deps || !deps.source || typeof deps.source.load !== 'function' || !(KEY_ENVIRONMENTS as readonly string[]).includes(deps.environment)) return { reason: 'SIGNER_CONFIG_MISSING' };
    let raw: unknown;
    try { raw = await deps.source.load(); } catch { return { reason: 'SIGNER_CONFIG_UNAVAILABLE' }; }
    if (raw === null || raw === undefined) return { reason: 'SIGNER_CONFIG_MISSING' };
    const rec = parse(raw);
    if (!rec) return { reason: 'SIGNER_CONFIG_MALFORMED' };
    if (rec.environment !== deps.environment) return { reason: 'SIGNER_WRONG_ENVIRONMENT' };
    const now = deps.clock();
    if (rec.revokedAtMs !== null) return { reason: 'SIGNER_REVOKED' };
    if (now < rec.validFromMs) return { reason: 'SIGNER_NOT_YET_VALID' };
    if (now >= rec.expiresAtMs) return { reason: 'SIGNER_EXPIRED' };
    return { rec };
  };
  return Object.freeze({
    async resolve(): Promise<SigningWorkloadResolveResult> {
      const l = await load();
      if ('reason' in l) return { ok: false, reason: l.reason };
      const { revokedAtMs: _revoked, ...fields } = l.rec; void _revoked;
      const identity = Object.freeze({ ...fields, purposes: Object.freeze([...fields.purposes]), businessIds: Object.freeze([...fields.businessIds]) }) as unknown as SigningWorkloadIdentity;
      minted.add(identity);
      return { ok: true, identity };
    },
    async check(identity: unknown, use: SigningUse): Promise<SigningWorkloadDenial | null> {
      if (!isSigningWorkloadIdentity(identity)) return 'SIGNER_NOT_TRUSTED'; // includes every DEV-11 read-workload identity and every look-alike object
      const l = await load();
      if ('reason' in l) return l.reason;
      const rec = l.rec;
      if (rec.workloadId !== identity.workloadId) return 'SIGNER_NOT_TRUSTED';
      if (!use || use.environment !== rec.environment) return 'SIGNER_WRONG_ENVIRONMENT';
      if (typeof use.purpose !== 'string' || !(rec.purposes as readonly string[]).includes(use.purpose)) return 'SIGNER_PURPOSE_NOT_PERMITTED';
      if (typeof use.evidenceType !== 'string' || !(PURPOSE_EVIDENCE_TYPES[use.purpose as EvidenceSigningPurpose] ?? []).includes(use.evidenceType)) return 'SIGNER_EVIDENCE_TYPE_NOT_PERMITTED';
      if (typeof use.businessId !== 'string' || !rec.businessIds.includes(use.businessId)) return 'SIGNER_TENANT_NOT_PERMITTED';
      return null;
    },
  });
}

/** The production signing-workload source: DISABLED. No signing workload has been provisioned (an owner decision), so every resolve fails closed with SIGNER_CONFIG_MISSING. */
export function createUnprovisionedSigningWorkloadSource(): WorkloadConfigSource { return Object.freeze({ load: () => Promise.resolve(null) }); }
