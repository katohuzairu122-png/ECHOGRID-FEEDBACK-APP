import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { stripeEvidenceKeys } from '../../db/schema';
import { ControlEventWriter } from './control-events';
import { equalBytes, rewrapDek, unwrapDek, type WrappedDek } from './envelope';
import { loadKeyring, KEYRING_MAX_ENTRIES } from './keyring';

/**
 * HETA-01-F1 C.3: operator keyring generation, assembly and two-phase rotation. NEVER used by the Worker.
 * KEKs are generated offline under owner control; this module only produces/validates secret VALUES for the
 * operator to place. It does not provision, read or write any Cloudflare secret, and it never logs key bytes.
 * Control events record versions, cohorts and custody locations only (no key, no key-derived value).
 */
export interface KeyringEntryJson {
  cohort: string;
  kek_version: string;
  alg: 'AES-256-GCM';
  key: string;
  not_before: string;
  not_after: string;
  active: boolean;
}

export const CUSTODY_LOCATIONS = ['worker_secret', 'primary_escrow', 'secondary_escrow', 'operator_forensic_env'] as const;
export type CustodyLocation = (typeof CUSTODY_LOCATIONS)[number];

const MONTH_START = (cohort: string) => Date.UTC(Number(cohort.slice(0, 4)), Number(cohort.slice(5, 7)) - 1, 1);
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

/** Generates a fresh random KEK entry (CSPRNG). Default window is the cohort's calendar month (UTC). */
export function generateKekEntry(p: { cohort: string; kekVersion: string; active?: boolean; notBefore?: Date; notAfter?: Date }): KeyringEntryJson {
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])(:[a-z0-9_]+)?$/.test(p.cohort)) throw new Error('cohort must match YYYY-MM[:class]');
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(p.kekVersion)) throw new Error('kek_version must be 1-32 chars of [A-Za-z0-9._-]');
  const start = MONTH_START(p.cohort);
  const next = new Date(start);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return {
    cohort: p.cohort, kek_version: p.kekVersion, alg: 'AES-256-GCM', key: b64(crypto.getRandomValues(new Uint8Array(32))),
    not_before: (p.notBefore ?? new Date(start)).toISOString(), not_after: (p.notAfter ?? next).toISOString(), active: p.active ?? true,
  };
}

const parse = (json: string): { v: 1; keys: KeyringEntryJson[] } => {
  const d = JSON.parse(json) as { v?: number; keys?: KeyringEntryJson[] };
  if (d.v !== 1 || !Array.isArray(d.keys)) throw new Error('not a keyring v1 document');
  return d as { v: 1; keys: KeyringEntryJson[] };
};
const serialize = (keys: KeyringEntryJson[]) => JSON.stringify({ v: 1, keys });

/** Builds the keyring secret value from entries. Schema, size and uniqueness rules are enforced by loadKeyring at the caller's `now`. */
export function assembleKeyring(entries: readonly KeyringEntryJson[]): string {
  if (entries.length === 0 || entries.length > KEYRING_MAX_ENTRIES) throw new Error(`keyring must hold 1-${KEYRING_MAX_ENTRIES} entries`);
  return serialize([...entries]);
}

/** Phase 1 of rotation (C.3): add the new KEK version while the old one stays. The new entry is added INACTIVE so the cohort keeps one active entry. */
export function addKeyringEntry(keyringJson: string, entry: KeyringEntryJson): string {
  const k = parse(keyringJson);
  if (k.keys.some(e => e.cohort === entry.cohort && e.kek_version === entry.kek_version)) throw new Error('entry already present');
  if (k.keys.length >= KEYRING_MAX_ENTRIES) throw new Error('keyring is full');
  return serialize([...k.keys, { ...entry, active: false }]);
}

/**
 * Phase 2 of rotation: remove the OLD entry and make the new one the cohort's active entry, in one step, so the
 * Worker never lacks a usable KEK for the cohort. Callers must run verifyRemovalSafe first.
 */
export function completeRotation(keyringJson: string, cohort: string, oldVersion: string, newVersion: string): string {
  const k = parse(keyringJson);
  const old = k.keys.find(e => e.cohort === cohort && e.kek_version === oldVersion);
  const neu = k.keys.find(e => e.cohort === cohort && e.kek_version === newVersion);
  if (!old || !neu) throw new Error('both the old and the new entry must be present');
  return serialize(k.keys.filter(e => e !== old).map(e => (e === neu ? { ...e, active: old.active || e.active } : e)));
}

export async function importKek(entry: KeyringEntryJson): Promise<CryptoKey> {
  const raw = Buffer.from(entry.key, 'base64');
  if (raw.length !== 32) throw new Error('KEK must be exactly 32 bytes');
  try {
    return await crypto.subtle.importKey('raw', raw as unknown as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
}

/** Custody inventory (C.3): required at generation. Non-secret identifiers only. */
export async function recordKekGenerated(db: Database, p: { cohort: string; kekVersion: string; locations: readonly CustodyLocation[]; actor: string; commitSha?: string | undefined; approvalRef?: string | undefined }): Promise<boolean> {
  if (p.locations.length === 0 || p.locations.some(l => !(CUSTODY_LOCATIONS as readonly string[]).includes(l))) throw new Error('locations must be a non-empty subset of the custody inventory');
  return new ControlEventWriter(db).append({
    kind: 'kek_generated', actor: p.actor, commitSha: p.commitSha, approvalRef: p.approvalRef,
    dedupeKey: `kekgen:${p.cohort}:${p.kekVersion}`, details: { cohort: p.cohort, kekVersion: p.kekVersion, locations: [...p.locations] },
  });
}

const rowToWrapped = (r: typeof stripeEvidenceKeys.$inferSelect): WrappedDek => ({ wrappedDek: r.wrappedDek, wrapNonce: r.wrapNonce, dekFingerprint: r.dekFingerprint });
const buf = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);

export interface RewrapResult {
  cohort: string;
  fromVersion: string;
  toVersion: string;
  /** The re-wrapped row unwraps under the new KEK and wraps the same DEK (fingerprint equal). Always checked before any write. */
  verified: boolean;
  applied: boolean;
}

/**
 * Operator rotation primitive: unwrap the cohort DEK under the OLD KEK, wrap the SAME DEK under the NEW KEK, verify the
 * new row unwraps and the fingerprint is equal, then (only with apply) insert it and a `kek_rotated` event in one
 * transaction. Ciphertext rows and the DEK never change; a failure leaves the previous state valid. Not re-encryption.
 */
export async function rewrapCohort(db: Database, p: { cohort: string; fromVersion: string; toVersion: string; oldKek: CryptoKey; newKek: CryptoKey; actor: string; commitSha?: string | undefined; approvalRef?: string | undefined; apply: boolean }): Promise<RewrapResult> {
  const k = stripeEvidenceKeys;
  const old = (await db.select().from(k).where(and(eq(k.cohort, p.cohort), eq(k.kekVersion, p.fromVersion))))[0];
  if (!old) throw new Error('no wrapped row for the source (cohort, kek_version)');
  const wrapped = await rewrapDek(p.oldKek, rowToWrapped(old), p.cohort, p.fromVersion, p.newKek, p.toVersion);
  // Verify BEFORE any write: the new row must unwrap under the new KEK and wrap the same DEK.
  await unwrapDek(p.newKek, wrapped, p.cohort, p.toVersion);
  const verified = equalBytes(wrapped.dekFingerprint, old.dekFingerprint);
  if (!verified) throw new Error('fingerprint mismatch after rewrap');
  if (!p.apply) return { cohort: p.cohort, fromVersion: p.fromVersion, toVersion: p.toVersion, verified, applied: false };
  await db.transaction(async tx => {
    const inserted = await tx.insert(k).values({
      cohort: p.cohort, kekVersion: p.toVersion, wrappedDek: buf(wrapped.wrappedDek), wrapNonce: buf(wrapped.wrapNonce),
      wrapAlgorithm: 'AES-256-GCM', dekFingerprint: buf(wrapped.dekFingerprint),
    }).onConflictDoNothing({ target: [k.cohort, k.kekVersion] }).returning({ id: k.id });
    if (inserted.length === 0) throw new Error('a wrapped row for the target version already exists');
    await new ControlEventWriter(tx as unknown as Database).append({
      kind: 'kek_rotated', actor: p.actor, commitSha: p.commitSha, approvalRef: p.approvalRef,
      dedupeKey: `kekrot:${p.cohort}:${p.fromVersion}:${p.toVersion}`, details: { cohort: p.cohort, fromVersion: p.fromVersion, toVersion: p.toVersion },
    });
  });
  return { cohort: p.cohort, fromVersion: p.fromVersion, toVersion: p.toVersion, verified, applied: true };
}

export interface RemovalCheck { safe: boolean; reasons: string[] }

/**
 * Gate for phase 2 (C.3): removing `removeVersion` is safe only if the post-removal keyring still holds a KEK that
 * unwraps a recorded wrapped row of the cohort whose fingerprint equals the removed version's row.
 */
export async function verifyRemovalSafe(db: Database, p: { cohort: string; removeVersion: string; remainingKeyringJson: string; now: Date }): Promise<RemovalCheck> {
  const reasons: string[] = [];
  const rows = await db.select().from(stripeEvidenceKeys).where(eq(stripeEvidenceKeys.cohort, p.cohort));
  const removed = rows.find(r => r.kekVersion === p.removeVersion);
  if (!removed) reasons.push('NO_ROW_FOR_REMOVED_VERSION');
  const remaining = parse(p.remainingKeyringJson).keys;
  if (remaining.some(e => e.cohort === p.cohort && e.kek_version === p.removeVersion)) reasons.push('REMOVED_VERSION_STILL_IN_KEYRING');
  let ok = false;
  try {
    await loadKeyring(p.remainingKeyringJson, p.now);
  } catch (e) {
    reasons.push(`REMAINING_KEYRING_INVALID:${(e as { code?: string }).code ?? 'ERR'}`);
  }
  for (const e of remaining.filter(x => x.cohort === p.cohort)) {
    const row = rows.find(r => r.kekVersion === e.kek_version);
    if (!row || !removed) continue;
    try {
      await unwrapDek(await importKek(e), rowToWrapped(row), p.cohort, e.kek_version);
      if (equalBytes(row.dekFingerprint, removed.dekFingerprint)) ok = true;
    } catch { /* this entry cannot unwrap its row */ }
  }
  if (!ok) reasons.push('NO_REMAINING_KEK_UNWRAPS_SAME_DEK');
  return { safe: reasons.length === 0, reasons };
}
