import type { ReadMethodId } from './capability-registry';
import type { ReadGate, WorkloadDenial } from './read-gate';
import type { MappingRegistry } from './mapping-authority';
import type { ReadAuthorizationStore } from './read-authorization';
import type { KeyPurpose } from './trusted-runtime';
import type { PerformableMethod } from './transport';

/**
 * S08-D1D3-DEV-11: TRUSTED WORKLOAD IDENTITY for the private Stripe verifier. The identity originates ONLY from trusted runtime configuration (`WorkloadConfigSource`, read server-side by the verifier workload
 * itself) and is reloaded on every check, so expiry and revocation take effect on the next request. No request, browser session, business administrator or administrator context can supply or substitute one:
 * `resolve` takes no identity argument, and a `TrustedWorkloadIdentity` is a frozen, branded, WeakSet-registered object that nothing else constructs.
 *
 * It binds the stable workload id, the deployment environment, the allowed Stripe TEST account, the realm, the permitted read methods (only the two performable ones can ever be listed), the credential
 * reference, the signing-key purpose, the validity period and the revocation state. Any missing, malformed, expired, revoked or mismatched piece denies. Production provisioning of this configuration is
 * an owner decision; nothing here reads an environment variable, so no setting can widen the methods.
 */
declare const BRAND: unique symbol;
export type WorkloadEnvironment = 'development' | 'staging' | 'production';
const ENVIRONMENTS: readonly string[] = ['development', 'staging', 'production'];
const PERFORMABLE: readonly string[] = ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'];
const WORKLOAD_ID = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$/;
const ACCOUNT = /^acct_[A-Za-z0-9]{1,128}$/;
const CREDENTIAL_REF = /^cred:[a-z0-9][a-z0-9._-]{0,63}$/;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

export interface TrustedWorkloadIdentity {
  readonly [BRAND]: true;
  readonly workloadId: string;
  readonly environment: WorkloadEnvironment;
  readonly accountId: string;
  readonly realm: 'test';
  readonly methods: readonly PerformableMethod[];
  readonly credentialRef: string;
  readonly signingKeyPurpose: KeyPurpose;
  readonly validFromMs: number;
  readonly expiresAtMs: number;
}
const minted = new WeakSet<object>();
export const isTrustedWorkloadIdentity = (x: unknown): x is TrustedWorkloadIdentity => x !== null && typeof x === 'object' && minted.has(x);

/** Trusted runtime configuration. Implemented by the verifier workload's own configuration loader; never by anything reachable from a request. */
export interface WorkloadConfigSource { load(): Promise<unknown> }

interface WorkloadRecord { workloadId: string; environment: WorkloadEnvironment; accountId: string; realm: 'test'; methods: PerformableMethod[]; credentialRef: string; signingKeyPurpose: KeyPurpose; validFromMs: number; expiresAtMs: number; revokedAtMs: number | null }
const RECORD_KEYS = ['workloadId', 'environment', 'accountId', 'realm', 'methods', 'credentialRef', 'signingKeyPurpose', 'validFromMs', 'expiresAtMs', 'revokedAtMs'];

function parseRecord(raw: unknown): WorkloadRecord | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).length !== RECORD_KEYS.length || !RECORD_KEYS.every(k => has(r, k))) return null;
  if (typeof r.workloadId !== 'string' || !WORKLOAD_ID.test(r.workloadId) || typeof r.environment !== 'string' || !ENVIRONMENTS.includes(r.environment)) return null;
  if (typeof r.accountId !== 'string' || !ACCOUNT.test(r.accountId) || r.realm !== 'test') return null;
  if (!Array.isArray(r.methods) || r.methods.length === 0 || r.methods.length > PERFORMABLE.length || new Set(r.methods).size !== r.methods.length || !r.methods.every(m => typeof m === 'string' && PERFORMABLE.includes(m))) return null;
  if (typeof r.credentialRef !== 'string' || !CREDENTIAL_REF.test(r.credentialRef) || /(rk|sk)_(test|live)/i.test(r.credentialRef)) return null;
  if (r.signingKeyPurpose !== 'TRUSTED_RUNTIME' && r.signingKeyPurpose !== 'SYNTHETIC_RUNTIME') return null;
  if (!isInt(r.validFromMs) || !isInt(r.expiresAtMs) || r.expiresAtMs <= r.validFromMs) return null;
  if (r.revokedAtMs !== null && !isInt(r.revokedAtMs)) return null;
  return r as unknown as WorkloadRecord;
}

export type WorkloadResolveDenial = Extract<WorkloadDenial, 'WORKLOAD_CONFIG_MISSING' | 'WORKLOAD_CONFIG_UNAVAILABLE' | 'WORKLOAD_WRONG_ENVIRONMENT' | 'WORKLOAD_EXPIRED' | 'WORKLOAD_NOT_YET_VALID' | 'WORKLOAD_REVOKED'> | 'WORKLOAD_CONFIG_MALFORMED';
export type WorkloadResolveResult = Readonly<{ ok: true; identity: TrustedWorkloadIdentity }> | Readonly<{ ok: false; reason: WorkloadResolveDenial }>;
export interface WorkloadUse { readonly environment: string; readonly accountId: string; readonly realm: string; readonly methodId: ReadMethodId | string }

export interface WorkloadAuthority {
  /** The identity from trusted configuration for the configured environment, or a denial. There is no parameter through which a caller names a workload. */
  resolve(): Promise<WorkloadResolveResult>;
  /** Re-reads the configuration and decides whether this exact identity may perform this exact use NOW. */
  check(identity: unknown, use: WorkloadUse): Promise<WorkloadDenial | null>;
}

export function createWorkloadAuthority(deps: Readonly<{ source: WorkloadConfigSource | null | undefined; environment: WorkloadEnvironment; clock: () => number }>): WorkloadAuthority {
  const load = async (): Promise<{ rec: WorkloadRecord } | { reason: WorkloadResolveDenial }> => {
    if (!deps || !deps.source || typeof deps.source.load !== 'function' || !ENVIRONMENTS.includes(deps.environment)) return { reason: 'WORKLOAD_CONFIG_MISSING' };
    let raw: unknown;
    try { raw = await deps.source.load(); } catch { return { reason: 'WORKLOAD_CONFIG_UNAVAILABLE' }; }
    if (raw === null || raw === undefined) return { reason: 'WORKLOAD_CONFIG_MISSING' };
    const rec = parseRecord(raw);
    if (!rec) return { reason: 'WORKLOAD_CONFIG_MALFORMED' };
    if (rec.environment !== deps.environment) return { reason: 'WORKLOAD_WRONG_ENVIRONMENT' };
    const now = deps.clock();
    if (rec.revokedAtMs !== null) return { reason: 'WORKLOAD_REVOKED' };
    if (now < rec.validFromMs) return { reason: 'WORKLOAD_NOT_YET_VALID' };
    if (now >= rec.expiresAtMs) return { reason: 'WORKLOAD_EXPIRED' };
    return { rec };
  };
  return Object.freeze({
    async resolve(): Promise<WorkloadResolveResult> {
      const l = await load();
      if ('reason' in l) return { ok: false, reason: l.reason };
      const { revokedAtMs: _revoked, ...fields } = l.rec; void _revoked;
      const identity = Object.freeze({ ...fields, methods: Object.freeze([...fields.methods]) }) as unknown as TrustedWorkloadIdentity;
      minted.add(identity);
      return { ok: true, identity };
    },
    async check(identity: unknown, use: WorkloadUse): Promise<WorkloadDenial | null> {
      if (!isTrustedWorkloadIdentity(identity)) return 'WORKLOAD_NOT_TRUSTED';
      const l = await load();
      if ('reason' in l) return l.reason === 'WORKLOAD_CONFIG_MALFORMED' ? 'WORKLOAD_CONFIG_UNAVAILABLE' : l.reason;
      const rec = l.rec;
      if (rec.workloadId !== identity.workloadId) return 'WORKLOAD_NOT_TRUSTED'; // the configuration no longer names this workload
      if (!use || use.environment !== rec.environment) return 'WORKLOAD_WRONG_ENVIRONMENT';
      if (use.accountId !== rec.accountId) return 'WORKLOAD_WRONG_ACCOUNT';
      if (use.realm !== rec.realm) return 'WORKLOAD_WRONG_REALM';
      if (typeof use.methodId !== 'string' || !rec.methods.includes(use.methodId as PerformableMethod)) return 'WORKLOAD_METHOD_NOT_PERMITTED';
      return null;
    },
  });
}

/**
 * The ONLY way to build a `ReadGate` for the verifier workload: the gate's workload id comes from the verified identity (never from a request), and its `workloadCheck` consults the authority first on every
 * read, so a workload that is expired, revoked, in the wrong environment/account/realm or out of method scope is denied before the authorization store and before any credential resolution.
 */
export function gateForWorkload(deps: Readonly<{ authority: WorkloadAuthority; identity: TrustedWorkloadIdentity; store: ReadAuthorizationStore; mapping: MappingRegistry }>): ReadGate {
  if (!isTrustedWorkloadIdentity(deps?.identity)) throw new Error('WORKLOAD_NOT_TRUSTED');
  const { authority, identity } = deps;
  return Object.freeze({
    store: deps.store, workloadId: identity.workloadId, mapping: deps.mapping,
    workloadCheck: (q: Readonly<{ accountId: string; methodId: ReadMethodId }>) => authority.check(identity, { environment: identity.environment, accountId: q.accountId, realm: 'test', methodId: q.methodId }),
  });
}
