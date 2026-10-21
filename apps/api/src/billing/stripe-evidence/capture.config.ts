import { loadKeyring, EvidenceKeyringError, type LoadedKeyring } from './keyring';
import type { SigningSecret } from './signature';

/**
 * HETA-01-F1 E.1 / G.1 Class S: system preconditions evaluated AFTER authentication and BEFORE any storage.
 * Every failure is a stable code (never a value); the handler maps any failure to 503 with nothing stored.
 * The three historical-authority flags are NOT configurable here or anywhere: this module has no such input.
 */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576; // C1 placeholder until measured (H4); the database ceiling is 16 MiB
export const HARD_MAX_BODY_BYTES = 16_777_216;
export const DEFAULT_L2_MAX_AGE_SECONDS = 86_400; // L2_MAX_AGE (H2): attestation must be fresher than this
export const DEFAULT_LEASE_SECONDS = 600; // L (H19)

export interface CaptureEnv {
  STRIPE_EVIDENCE_CAPTURE?: string | undefined;
  STRIPE_PROJECTION_MODE?: string | undefined;
  STRIPE_ACCOUNT_ID?: string | undefined;
  STRIPE_EXPECTED_LIVEMODE?: string | undefined;
  STRIPE_WEBHOOK_SECRET?: string | undefined;
  STRIPE_WEBHOOK_SECRET_PREVIOUS?: string | undefined;
  EVIDENCE_KEK_KEYRING?: string | undefined;
  EVIDENCE_RETENTION_POLICY_VERSION?: string | undefined;
  EVIDENCE_RETENTION_DAYS?: string | undefined;
  EVIDENCE_MAX_BODY_BYTES?: string | undefined;
  EVIDENCE_L2_MAX_AGE_SECONDS?: string | undefined;
  EVIDENCE_LEASE_SECONDS?: string | undefined;
}

export type PreconditionCode =
  | 'CAPTURE_MODE_INVALID' | 'PROJECTION_MODE_NOT_LEGACY' | 'ACCOUNT_ID_INVALID' | 'LIVEMODE_UNSET' | 'WEBHOOK_SECRET_MISSING'
  | 'RETENTION_UNAPPROVED' | 'LIMITS_INVALID' | 'KEYRING_INVALID' | 'ATTESTATION_NOT_CURRENT' | 'DATABASE_UNREACHABLE' | 'KEK_UNAVAILABLE';

export type CaptureMode = 'off' | 'enforced';

/** `off` (or unset) is today's behavior. Anything other than off/enforced is a precondition failure on the enforced path. */
export function isCaptureOff(env: CaptureEnv): boolean {
  const v = env.STRIPE_EVIDENCE_CAPTURE;
  return v === undefined || v === '' || v === 'off';
}

export interface ResolvedConfig {
  receivingAccountId: string;
  expectedLivemode: boolean;
  secrets: SigningSecret[];
  retention: { policyVersion: string; days: number };
  maxBodyBytes: number;
  l2MaxAgeSeconds: number;
  leaseSeconds: number;
}

const int = (v: string | undefined, dflt: number, min: number, max: number): number | null => {
  if (v === undefined || v === '') return dflt;
  return /^[0-9]{1,10}$/.test(v) && Number(v) >= min && Number(v) <= max ? Number(v) : null;
};

/** Size cap alone (needed before authentication, so it must not depend on the rest of the configuration). */
export function maxBodyBytes(env: CaptureEnv): number {
  return int(env.EVIDENCE_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES, 1, HARD_MAX_BODY_BYTES) ?? DEFAULT_MAX_BODY_BYTES;
}

/** Synchronous Class S checks. Returns every failing code so one bucket can record all of them. */
export function resolveConfig(env: CaptureEnv): { ok: true; cfg: ResolvedConfig } | { ok: false; failures: PreconditionCode[] } {
  const failures: PreconditionCode[] = [];
  if (env.STRIPE_EVIDENCE_CAPTURE !== 'enforced') failures.push('CAPTURE_MODE_INVALID');
  if (env.STRIPE_PROJECTION_MODE !== undefined && env.STRIPE_PROJECTION_MODE !== '' && env.STRIPE_PROJECTION_MODE !== 'legacy') failures.push('PROJECTION_MODE_NOT_LEGACY');
  if (!env.STRIPE_ACCOUNT_ID || !/^acct_[A-Za-z0-9]+$/.test(env.STRIPE_ACCOUNT_ID)) failures.push('ACCOUNT_ID_INVALID');
  if (env.STRIPE_EXPECTED_LIVEMODE !== 'true' && env.STRIPE_EXPECTED_LIVEMODE !== 'false') failures.push('LIVEMODE_UNSET');
  if (!env.STRIPE_WEBHOOK_SECRET) failures.push('WEBHOOK_SECRET_MISSING');
  const days = int(env.EVIDENCE_RETENTION_DAYS, NaN, 1, 36_500);
  if (!env.EVIDENCE_RETENTION_POLICY_VERSION || days === null || Number.isNaN(days)) failures.push('RETENTION_UNAPPROVED');
  const max = int(env.EVIDENCE_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES, 1, HARD_MAX_BODY_BYTES);
  const l2 = int(env.EVIDENCE_L2_MAX_AGE_SECONDS, DEFAULT_L2_MAX_AGE_SECONDS, 60, 31_536_000);
  const lease = int(env.EVIDENCE_LEASE_SECONDS, DEFAULT_LEASE_SECONDS, 30, 3600);
  if (max === null || l2 === null || lease === null) failures.push('LIMITS_INVALID');
  if (failures.length > 0) return { ok: false, failures };
  const secrets: SigningSecret[] = [{ label: 'primary', secret: env.STRIPE_WEBHOOK_SECRET! }];
  if (env.STRIPE_WEBHOOK_SECRET_PREVIOUS) secrets.push({ label: 'previous', secret: env.STRIPE_WEBHOOK_SECRET_PREVIOUS });
  return {
    ok: true,
    cfg: {
      receivingAccountId: env.STRIPE_ACCOUNT_ID!, expectedLivemode: env.STRIPE_EXPECTED_LIVEMODE === 'true', secrets,
      retention: { policyVersion: env.EVIDENCE_RETENTION_POLICY_VERSION!, days: days! }, maxBodyBytes: max!, l2MaxAgeSeconds: l2!, leaseSeconds: lease!,
    },
  };
}

/** Keyring precondition: valid JSON schema, active KEK for the current cohort and runway >= 1 (C.3). */
export async function checkKeyring(env: CaptureEnv, now: Date): Promise<{ ok: true; keyring: LoadedKeyring } | { ok: false; code: 'KEYRING_INVALID'; detail: string }> {
  try {
    return { ok: true, keyring: await loadKeyring(env.EVIDENCE_KEK_KEYRING, now) };
  } catch (e) {
    return { ok: false, code: 'KEYRING_INVALID', detail: e instanceof EvidenceKeyringError ? e.code : 'KEYRING_ERROR' };
  }
}

/** Stream identity `<receiving_account_id>:<livemode>`; unusable configuration maps to a fixed `unconfigured:unknown` stream so failures stay recordable. */
export function streamForEnv(env: CaptureEnv): string {
  const acct = env.STRIPE_ACCOUNT_ID && /^acct_[A-Za-z0-9]+$/.test(env.STRIPE_ACCOUNT_ID) ? env.STRIPE_ACCOUNT_ID : 'unconfigured';
  const live = env.STRIPE_EXPECTED_LIVEMODE === 'true' || env.STRIPE_EXPECTED_LIVEMODE === 'false' ? env.STRIPE_EXPECTED_LIVEMODE : 'unknown';
  return `${acct}:${live}`;
}
