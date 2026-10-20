/**
 * HETA-01-F1 C.3: EVIDENCE_KEK_KEYRING loader. Fail closed: any defect throws EvidenceKeyringError, which
 * callers map to a Class S capture-precondition failure (503). Error messages carry a stable code only; the
 * keyring content and key bytes never appear in messages or logs. Keys are imported non-extractable.
 */
export const KEYRING_MAX_ENTRIES = 8;
const COHORT_RE = /^[0-9]{4}-(0[1-9]|1[0-2])(:[a-z0-9_]+)?$/;
const MONTH_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export type KeyringErrorCode =
  | 'KEYRING_MISSING' | 'KEYRING_NOT_JSON' | 'KEYRING_SCHEMA' | 'KEYRING_TOO_LARGE' | 'KEYRING_KEY_LENGTH'
  | 'KEYRING_DUPLICATE' | 'KEYRING_COHORT_PATTERN' | 'KEYRING_MULTIPLE_ACTIVE' | 'KEYRING_WINDOW'
  | 'KEYRING_NO_CURRENT_ACTIVE' | 'KEYRING_NO_RUNWAY';

export class EvidenceKeyringError extends Error {
  constructor(public readonly code: KeyringErrorCode) {
    super(`Evidence keyring invalid: ${code}`);
    this.name = 'EvidenceKeyringError';
  }
}

export interface KeyringEntry {
  cohort: string;
  kekVersion: string;
  notBefore: Date;
  notAfter: Date;
  active: boolean;
  key: CryptoKey;
}

export interface LoadedKeyring {
  entries: readonly KeyringEntry[];
  /** The active entry for the cohort of `at`, only if `at` lies in its window. */
  activeFor(at: Date): KeyringEntry;
  /** Entry for an exact (cohort, kek_version), used to unwrap stored DEK rows. */
  find(cohort: string, kekVersion: string): KeyringEntry | undefined;
}

/** UTC calendar month of the capture time (the retention cohort). */
export function cohortOf(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

function nextMonth(cohort: string): string {
  const y = Number(cohort.slice(0, 4));
  const m = Number(cohort.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function b64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  } catch {
    return null;
  }
}

interface RawEntry { cohort: unknown; kek_version: unknown; alg: unknown; key: unknown; not_before: unknown; not_after: unknown; active: unknown }

export async function loadKeyring(secret: string | undefined, now: Date, maxBytes = 65536): Promise<LoadedKeyring> {
  if (!secret) throw new EvidenceKeyringError('KEYRING_MISSING');
  if (secret.length > maxBytes) throw new EvidenceKeyringError('KEYRING_TOO_LARGE');
  let doc: unknown;
  try {
    doc = JSON.parse(secret);
  } catch {
    throw new EvidenceKeyringError('KEYRING_NOT_JSON');
  }
  if (!doc || typeof doc !== 'object' || (doc as { v?: unknown }).v !== 1 || !Array.isArray((doc as { keys?: unknown }).keys)) {
    throw new EvidenceKeyringError('KEYRING_SCHEMA');
  }
  const raw = (doc as { keys: RawEntry[] }).keys;
  if (raw.length === 0 || raw.length > KEYRING_MAX_ENTRIES) throw new EvidenceKeyringError(raw.length === 0 ? 'KEYRING_SCHEMA' : 'KEYRING_TOO_LARGE');

  const seen = new Set<string>();
  const activePerCohort = new Map<string, number>();
  const entries: KeyringEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object' || typeof e.cohort !== 'string' || typeof e.kek_version !== 'string' || e.kek_version === '' ||
        e.alg !== 'AES-256-GCM' || typeof e.key !== 'string' || typeof e.not_before !== 'string' || typeof e.not_after !== 'string' || typeof e.active !== 'boolean') {
      throw new EvidenceKeyringError('KEYRING_SCHEMA');
    }
    if (!COHORT_RE.test(e.cohort)) throw new EvidenceKeyringError('KEYRING_COHORT_PATTERN');
    const id = `${e.cohort}\u0000${e.kek_version}`;
    if (seen.has(id)) throw new EvidenceKeyringError('KEYRING_DUPLICATE');
    seen.add(id);
    const bytes = b64(e.key);
    if (!bytes || bytes.length !== 32) throw new EvidenceKeyringError('KEYRING_KEY_LENGTH');
    const notBefore = new Date(e.not_before);
    const notAfter = new Date(e.not_after);
    if (Number.isNaN(notBefore.getTime()) || Number.isNaN(notAfter.getTime()) || notBefore >= notAfter) throw new EvidenceKeyringError('KEYRING_WINDOW');
    if (e.active) activePerCohort.set(e.cohort, (activePerCohort.get(e.cohort) ?? 0) + 1);
    const key = await crypto.subtle.importKey('raw', bytes as unknown as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
    bytes.fill(0);
    entries.push({ cohort: e.cohort, kekVersion: e.kek_version, notBefore, notAfter, active: e.active, key });
  }
  if ([...activePerCohort.values()].some(n => n > 1)) throw new EvidenceKeyringError('KEYRING_MULTIPLE_ACTIVE');

  const usable = (cohort: string) => entries.some(e => e.cohort === cohort && e.active && e.notBefore <= now && now < e.notAfter);
  const current = cohortOf(now);
  if (!usable(current)) throw new EvidenceKeyringError('KEYRING_NO_CURRENT_ACTIVE');
  const next = nextMonth(current);
  // Runway: at least one usable next-cohort entry (active, valid by the end of the current month), else month rollover would fail closed.
  const nextOk = entries.some(e => e.cohort === next && e.active && MONTH_RE.test(e.cohort) && e.notBefore <= new Date(Date.UTC(Number(next.slice(0, 4)), Number(next.slice(5)) - 1, 1)) && e.notAfter > new Date(Date.UTC(Number(next.slice(0, 4)), Number(next.slice(5)) - 1, 1)));
  if (!nextOk) throw new EvidenceKeyringError('KEYRING_NO_RUNWAY');

  return {
    entries,
    activeFor(at: Date) {
      const c = cohortOf(at);
      const hit = entries.find(e => e.cohort === c && e.active && e.notBefore <= at && at < e.notAfter);
      if (!hit) throw new EvidenceKeyringError('KEYRING_NO_CURRENT_ACTIVE');
      return hit;
    },
    find: (cohort, kekVersion) => entries.find(e => e.cohort === cohort && e.kekVersion === kekVersion),
  };
}
