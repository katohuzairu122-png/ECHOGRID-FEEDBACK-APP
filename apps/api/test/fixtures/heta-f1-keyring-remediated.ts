/**
 * Block E corrected TEST-ONLY copy of candidate 86f709d, not a runtime keyring.
 * Candidate identity/cohort/runway rules are retained for compatibility testing,
 * not approved as policy. No capture, HTTP, retention or custody mapping.
 */
export const KEYRING_MAX_ENTRIES = 8;
const COHORT_RE = /^[0-9]{4}-(0[1-9]|1[0-2])(:[a-z0-9_]+)?$/;
const MONTH_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
export type KeyringErrorCode =
  | 'KEYRING_MISSING'
  | 'KEYRING_NOT_JSON'
  | 'KEYRING_SCHEMA'
  | 'KEYRING_TOO_LARGE'
  | 'KEYRING_KEY_LENGTH'
  | 'KEYRING_DUPLICATE'
  | 'KEYRING_COHORT_PATTERN'
  | 'KEYRING_MULTIPLE_ACTIVE'
  | 'KEYRING_WINDOW'
  | 'KEYRING_NO_CURRENT_ACTIVE'
  | 'KEYRING_NO_RUNWAY'
  | 'KEYRING_IMPORT_FAILED';
export class EvidenceKeyringError extends Error {
  constructor(public readonly code: KeyringErrorCode) {
    super(`Evidence keyring invalid: ${code}`);
    this.name = 'EvidenceKeyringError';
  }
}
export interface KeyringEntry {
  readonly cohort: string;
  readonly kekVersion: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly active: boolean;
  readonly key: CryptoKey;
}
export interface LoadedKeyring {
  readonly entries: readonly KeyringEntry[];
  activeFor(at: Date): KeyringEntry;
  find(cohort: string, kekVersion: string): KeyringEntry | undefined;
}
interface InternalEntry {
  cohort: string;
  kekVersion: string;
  notBeforeMs: number;
  notAfterMs: number;
  active: boolean;
  key: CryptoKey;
}
interface RawEntry {
  cohort: unknown;
  kek_version: unknown;
  alg: unknown;
  key: unknown;
  not_before: unknown;
  not_after: unknown;
  active: unknown;
}
function clockMs(at: Date): number {
  const ms = at instanceof Date ? at.getTime() : Number.NaN;
  if (!Number.isFinite(ms)) throw new EvidenceKeyringError('KEYRING_SCHEMA');
  return ms;
}
export function cohortOf(at: Date): string {
  const instant = new Date(clockMs(at));
  return `${instant.getUTCFullYear()}-${String(instant.getUTCMonth() + 1).padStart(2, '0')}`;
}
function nextMonth(cohort: string): string {
  const y = Number(cohort.slice(0, 4));
  const m = Number(cohort.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
// Count UTF-8 bytes without allocating another encoded secret-content buffer.
// Unpaired UTF-16 surrogates match TextEncoder's three-byte replacement behavior.
function fitsUtf8(value: string, limit: number): boolean {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x7f) bytes++;
    else if (c <= 0x7ff) bytes += 2;
    else if (
      c >= 0xd800 &&
      c <= 0xdbff &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
    if (bytes > limit) return false;
  }
  return true;
}
function b64(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
export async function loadKeyring(
  secret: string | undefined,
  now: Date,
  maxBytes = 65536,
): Promise<LoadedKeyring> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new EvidenceKeyringError('KEYRING_SCHEMA');
  const verificationMs = clockMs(now);
  const verificationAt = new Date(verificationMs);
  if (!secret) throw new EvidenceKeyringError('KEYRING_MISSING');
  if (typeof secret !== 'string') throw new EvidenceKeyringError('KEYRING_SCHEMA');
  if (!fitsUtf8(secret, maxBytes)) throw new EvidenceKeyringError('KEYRING_TOO_LARGE');
  let doc: unknown;
  try {
    doc = JSON.parse(secret);
  } catch {
    throw new EvidenceKeyringError('KEYRING_NOT_JSON');
  }
  if (
    !doc ||
    typeof doc !== 'object' ||
    (doc as { v?: unknown }).v !== 1 ||
    !Array.isArray((doc as { keys?: unknown }).keys)
  )
    throw new EvidenceKeyringError('KEYRING_SCHEMA');
  const raw = (doc as { keys: RawEntry[] }).keys;
  if (raw.length === 0 || raw.length > KEYRING_MAX_ENTRIES)
    throw new EvidenceKeyringError(raw.length === 0 ? 'KEYRING_SCHEMA' : 'KEYRING_TOO_LARGE');
  const seen = new Set<string>();
  const activePerCohort = new Map<string, number>();
  const entries: InternalEntry[] = [];
  for (const e of raw) {
    if (
      !e ||
      typeof e !== 'object' ||
      typeof e.cohort !== 'string' ||
      typeof e.kek_version !== 'string' ||
      e.kek_version === '' ||
      e.alg !== 'AES-256-GCM' ||
      typeof e.key !== 'string' ||
      typeof e.not_before !== 'string' ||
      typeof e.not_after !== 'string' ||
      typeof e.active !== 'boolean'
    )
      throw new EvidenceKeyringError('KEYRING_SCHEMA');
    if (!COHORT_RE.test(e.cohort)) throw new EvidenceKeyringError('KEYRING_COHORT_PATTERN');
    const id = `${e.cohort}\u0000${e.kek_version}`;
    if (seen.has(id)) throw new EvidenceKeyringError('KEYRING_DUPLICATE');
    seen.add(id);
    const bytes = b64(e.key);
    if (!bytes) throw new EvidenceKeyringError('KEYRING_KEY_LENGTH');
    try {
      if (bytes.length !== 32) throw new EvidenceKeyringError('KEYRING_KEY_LENGTH');
      const notBeforeMs = new Date(e.not_before).getTime();
      const notAfterMs = new Date(e.not_after).getTime();
      if (
        !Number.isFinite(notBeforeMs) ||
        !Number.isFinite(notAfterMs) ||
        notBeforeMs >= notAfterMs
      )
        throw new EvidenceKeyringError('KEYRING_WINDOW');
      if (e.active) activePerCohort.set(e.cohort, (activePerCohort.get(e.cohort) ?? 0) + 1);
      let key: CryptoKey;
      try {
        key = await crypto.subtle.importKey(
          'raw',
          bytes as unknown as BufferSource,
          'AES-GCM',
          false,
          ['encrypt', 'decrypt'],
        );
      } catch {
        throw new EvidenceKeyringError('KEYRING_IMPORT_FAILED');
      }
      // Preserve the genuine CryptoKey handle while preventing accidental metadata shadowing.
      Object.freeze(key.algorithm);
      Object.freeze(key.usages);
      Object.freeze(key);
      entries.push({
        cohort: e.cohort,
        kekVersion: e.kek_version,
        notBeforeMs,
        notAfterMs,
        active: e.active,
        key,
      });
    } finally {
      bytes.fill(0);
    }
  }
  if ([...activePerCohort.values()].some((n) => n > 1))
    throw new EvidenceKeyringError('KEYRING_MULTIPLE_ACTIVE');
  const current = cohortOf(verificationAt);
  if (
    !entries.some(
      (e) =>
        e.cohort === current &&
        e.active &&
        e.notBeforeMs <= verificationMs &&
        verificationMs < e.notAfterMs,
    )
  )
    throw new EvidenceKeyringError('KEYRING_NO_CURRENT_ACTIVE');
  const next = nextMonth(current);
  const boundary = Date.UTC(Number(next.slice(0, 4)), Number(next.slice(5)) - 1, 1);
  if (
    !entries.some(
      (e) =>
        e.cohort === next &&
        e.active &&
        MONTH_RE.test(e.cohort) &&
        e.notBeforeMs <= boundary &&
        e.notAfterMs > boundary,
    )
  )
    throw new EvidenceKeyringError('KEYRING_NO_RUNWAY');
  const exposed = Object.freeze(
    entries.map((e) =>
      Object.freeze({
        cohort: e.cohort,
        kekVersion: e.kekVersion,
        active: e.active,
        key: e.key,
        get notBefore() {
          return new Date(e.notBeforeMs);
        },
        get notAfter() {
          return new Date(e.notAfterMs);
        },
      }),
    ),
  );
  return Object.freeze({
    entries: exposed,
    activeFor(at: Date) {
      const ms = clockMs(at);
      const cohort = cohortOf(new Date(ms));
      const index = entries.findIndex(
        (e) => e.cohort === cohort && e.active && e.notBeforeMs <= ms && ms < e.notAfterMs,
      );
      const hit = exposed[index];
      if (!hit) throw new EvidenceKeyringError('KEYRING_NO_CURRENT_ACTIVE');
      return hit;
    },
    find(cohort: string, kekVersion: string) {
      return exposed[entries.findIndex((e) => e.cohort === cohort && e.kekVersion === kekVersion)];
    },
  });
}
