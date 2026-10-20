/**
 * Standalone candidate-format AES-256-GCM envelopes (WebCrypto only).
 * No route/capture/custody integration or full-design approval is implied.
 * Pure functions; no database, no network, no secrets in messages. Plaintext DEK bytes exist only
 * inside wrapDek/unwrapDek; callers receive a non-extractable CryptoKey.
 */
export const EVIDENCE_SCHEMA_VERSION = 'heta01-f1/1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
// Existing migration 0045 payload_bytes constraint; not a new retention/size policy.
const MAX_PAYLOAD_BYTES = 16_777_216;
const DEK_FP_DOMAIN = 'heta01-f1-dek-fingerprint-v1\0';

export class EvidenceCryptoError extends Error {
  constructor(
    public readonly code:
      'DECRYPT_FAILED' | 'DIGEST_MISMATCH' | 'UNWRAP_FAILED' | 'FINGERPRINT_MISMATCH' | 'BAD_INPUT',
  ) {
    super(`Evidence crypto failure: ${code}`);
    this.name = 'EvidenceCryptoError';
  }
}

const enc = new TextEncoder();
// WebCrypto typings want ArrayBuffer-backed views; this keeps one cast in one place.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

function requireKey(key: CryptoKey): void {
  if (
    !key ||
    key.type !== 'secret' ||
    key.algorithm?.name !== 'AES-GCM' ||
    (key.algorithm as typeof key.algorithm & { length?: number }).length !== 256
  )
    throw new EvidenceCryptoError('BAD_INPUT');
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function requireWrapMetadata(cohort: string, version: string): void {
  if (!text(cohort) || !text(version)) throw new EvidenceCryptoError('BAD_INPUT');
}
function snapshotBinding(binding: EnvelopeBinding): EnvelopeBinding {
  if (!binding || !text(binding.table) || !text(binding.identity))
    throw new EvidenceCryptoError('BAD_INPUT');
  requireWrapMetadata(binding.cohort, binding.kekVersion);
  return {
    table: binding.table,
    identity: binding.identity,
    cohort: binding.cohort,
    kekVersion: binding.kekVersion,
  };
}
function requireWrapped(row: WrappedDek): void {
  if (
    !row ||
    !(row.wrappedDek instanceof Uint8Array) ||
    row.wrappedDek.length !== 32 + TAG_BYTES ||
    !(row.wrapNonce instanceof Uint8Array) ||
    row.wrapNonce.length !== NONCE_BYTES ||
    !(row.dekFingerprint instanceof Uint8Array) ||
    row.dekFingerprint.length !== 32
  )
    throw new EvidenceCryptoError('BAD_INPUT');
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bs(bytes)));
  } catch {
    throw new EvidenceCryptoError('BAD_INPUT');
  }
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return d === 0;
}

/** Canonical AAD: each field is length-prefixed (u32 big-endian) so field boundaries cannot be forged. */
export function canonicalAad(fields: readonly (string | Uint8Array)[]): Uint8Array {
  const parts = fields.map((f) => (typeof f === 'string' ? enc.encode(f) : f));
  const out = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0));
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const p of parts) {
    dv.setUint32(o, p.length);
    out.set(p, o + 4);
    o += 4 + p.length;
  }
  return out;
}

export interface EnvelopeBinding {
  table: string;
  /** Evidence-record identity, e.g. receiving|event account|livemode|event id|provenance (or the digest for malformed receipts). */
  identity: string;
  cohort: string;
  kekVersion: string;
}

function envelopeAad(b: EnvelopeBinding, payloadSha256: Uint8Array): Uint8Array {
  return canonicalAad([
    b.table,
    b.identity,
    payloadSha256,
    b.cohort,
    b.kekVersion,
    EVIDENCE_SCHEMA_VERSION,
  ]);
}

export interface SealedEnvelope {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  payloadSha256: Uint8Array;
  payloadBytes: number;
}

export async function sealPayload(
  dek: CryptoKey,
  plaintext: Uint8Array,
  binding: EnvelopeBinding,
): Promise<SealedEnvelope> {
  requireKey(dek);
  const bound = snapshotBinding(binding);
  if (
    !(plaintext instanceof Uint8Array) ||
    plaintext.length === 0 ||
    plaintext.length > MAX_PAYLOAD_BYTES
  )
    throw new EvidenceCryptoError('BAD_INPUT');
  const owned = new Uint8Array(plaintext);
  try {
    const payloadSha256 = await sha256(owned);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const ct = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: bs(nonce),
        additionalData: bs(envelopeAad(bound, payloadSha256)),
        tagLength: 128,
      },
      dek,
      bs(owned),
    );
    return { ciphertext: new Uint8Array(ct), nonce, payloadSha256, payloadBytes: owned.length };
  } catch {
    throw new EvidenceCryptoError('BAD_INPUT');
  } finally {
    owned.fill(0);
  }
}

/** Verifies the GCM tag AND recomputes the plaintext digest; any failure returns no partial plaintext. */
export async function openPayload(
  dek: CryptoKey,
  row: { ciphertext: Uint8Array; nonce: Uint8Array; payloadSha256: Uint8Array },
  binding: EnvelopeBinding,
): Promise<Uint8Array> {
  requireKey(dek);
  const bound = snapshotBinding(binding);
  if (
    !row ||
    !(row.ciphertext instanceof Uint8Array) ||
    row.ciphertext.length <= TAG_BYTES ||
    row.ciphertext.length > MAX_PAYLOAD_BYTES + TAG_BYTES ||
    !(row.nonce instanceof Uint8Array) ||
    row.nonce.length !== NONCE_BYTES ||
    !(row.payloadSha256 instanceof Uint8Array) ||
    row.payloadSha256.length !== 32
  )
    throw new EvidenceCryptoError('BAD_INPUT');
  const nonce = new Uint8Array(row.nonce);
  const ciphertext = new Uint8Array(row.ciphertext);
  const expectedDigest = new Uint8Array(row.payloadSha256);
  let pt: Uint8Array;
  try {
    pt = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: bs(nonce),
          additionalData: bs(envelopeAad(bound, expectedDigest)),
          tagLength: 128,
        },
        dek,
        bs(ciphertext),
      ),
    );
  } catch {
    throw new EvidenceCryptoError('DECRYPT_FAILED');
  }
  let digest: Uint8Array;
  try {
    digest = await sha256(pt);
  } catch {
    pt.fill(0);
    throw new EvidenceCryptoError('DECRYPT_FAILED');
  }
  if (!equalBytes(digest, expectedDigest)) {
    pt.fill(0);
    throw new EvidenceCryptoError('DIGEST_MISMATCH');
  }
  return pt;
}

export interface WrappedDek {
  wrappedDek: Uint8Array;
  wrapNonce: Uint8Array;
  dekFingerprint: Uint8Array;
}

async function dekFingerprint(raw: Uint8Array): Promise<Uint8Array> {
  return sha256(canonicalAad([DEK_FP_DOMAIN, raw]));
}

const wrapAad = (cohort: string, kekVersion: string) =>
  canonicalAad(['dek-wrap', cohort, kekVersion, EVIDENCE_SCHEMA_VERSION]);

/** Generates a fresh random DEK and wraps it under the KEK. Returns the wrapped row and a usable non-extractable DEK. */
export async function createWrappedDek(
  kek: CryptoKey,
  cohort: string,
  kekVersion: string,
): Promise<{ wrapped: WrappedDek; dek: CryptoKey }> {
  requireKey(kek);
  requireWrapMetadata(cohort, kekVersion);
  const raw = new Uint8Array(32);
  try {
    crypto.getRandomValues(raw);
    return { wrapped: await wrapRaw(kek, raw, cohort, kekVersion), dek: await importDek(raw) };
  } catch {
    throw new EvidenceCryptoError('BAD_INPUT');
  } finally {
    raw.fill(0);
  }
}

async function wrapRaw(
  kek: CryptoKey,
  raw: Uint8Array,
  cohort: string,
  kekVersion: string,
): Promise<WrappedDek> {
  const wrapNonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ct = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: bs(wrapNonce),
      additionalData: bs(wrapAad(cohort, kekVersion)),
      tagLength: 128,
    },
    kek,
    bs(raw),
  );
  return { wrappedDek: new Uint8Array(ct), wrapNonce, dekFingerprint: await dekFingerprint(raw) };
}

const importDek = (raw: Uint8Array) =>
  crypto.subtle.importKey('raw', bs(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);

/** Unwraps a stored DEK and verifies its fingerprint; the plaintext bytes never leave this function. */
export async function unwrapDek(
  kek: CryptoKey,
  row: WrappedDek,
  cohort: string,
  kekVersion: string,
): Promise<CryptoKey> {
  requireKey(kek);
  requireWrapMetadata(cohort, kekVersion);
  requireWrapped(row);
  const fingerprint = new Uint8Array(row.dekFingerprint);
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: bs(row.wrapNonce),
          additionalData: bs(wrapAad(cohort, kekVersion)),
          tagLength: 128,
        },
        kek,
        bs(row.wrappedDek),
      ),
    );
  } catch {
    throw new EvidenceCryptoError('UNWRAP_FAILED');
  }
  try {
    let digest: Uint8Array;
    try {
      digest = await dekFingerprint(raw);
    } catch {
      throw new EvidenceCryptoError('UNWRAP_FAILED');
    }
    if (raw.length !== 32 || !equalBytes(digest, fingerprint))
      throw new EvidenceCryptoError('FINGERPRINT_MISMATCH');
    try {
      return await importDek(raw);
    } catch {
      throw new EvidenceCryptoError('UNWRAP_FAILED');
    }
  } finally {
    raw.fill(0);
  }
}

/**
 * Operator rotation primitive (never the Worker): unwraps under the old KEK and re-wraps the SAME DEK
 * under the new KEK, returning a row whose fingerprint equals the original. Callers must verify the new row
 * unwraps before removing the old KEK (C.3).
 */
export async function rewrapDek(
  oldKek: CryptoKey,
  oldRow: WrappedDek,
  cohort: string,
  oldVersion: string,
  newKek: CryptoKey,
  newVersion: string,
): Promise<WrappedDek> {
  requireKey(oldKek);
  requireKey(newKek);
  requireWrapMetadata(cohort, oldVersion);
  requireWrapMetadata(cohort, newVersion);
  requireWrapped(oldRow);
  const fingerprint = new Uint8Array(oldRow.dekFingerprint);
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: bs(oldRow.wrapNonce),
          additionalData: bs(wrapAad(cohort, oldVersion)),
          tagLength: 128,
        },
        oldKek,
        bs(oldRow.wrappedDek),
      ),
    );
  } catch {
    throw new EvidenceCryptoError('UNWRAP_FAILED');
  }
  try {
    let digest: Uint8Array;
    try {
      digest = await dekFingerprint(raw);
    } catch {
      throw new EvidenceCryptoError('UNWRAP_FAILED');
    }
    if (raw.length !== 32 || !equalBytes(digest, fingerprint))
      throw new EvidenceCryptoError('FINGERPRINT_MISMATCH');
    try {
      return await wrapRaw(newKek, raw, cohort, newVersion);
    } catch {
      throw new EvidenceCryptoError('BAD_INPUT');
    }
  } finally {
    raw.fill(0);
  }
}
