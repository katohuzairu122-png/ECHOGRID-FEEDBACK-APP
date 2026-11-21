/**
 * AES-GCM sealed pending registration, bound to the HMAC digests of a single-use
 * email challenge. No plaintext password, name, email or password hash is persisted.
 * The key is derived from the dedicated registration HMAC secret via domain separation.
 */
import { normalizeLoginEmail } from './customer-email-challenge-digest';

export type PendingRegistration = { email: string; name: string; passwordHash: string };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEX64 = /^[0-9a-f]{64}$/;
const HASH = /^pbkdf2\$[1-9][0-9]*\$[^$]+\$[^$]+$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const toBase64Url = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
function fromBase64Url(value: string): Uint8Array | null {
  if (!B64.test(value) || value.length > 8192) return null;
  try {
    const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  } catch { return null; }
}
async function encryptionKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const keyBytes = await crypto.subtle.sign('HMAC', material, encoder.encode('echo-grid/customer-auth-ux-02/pending-registration/aes-gcm/v1'));
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function aad(subjectDigest: string, proofDigest: string): Uint8Array {
  if (!HEX64.test(subjectDigest) || !HEX64.test(proofDigest)) throw new Error('Invalid registration challenge digests');
  return encoder.encode('email_registration:' + subjectDigest + ':' + proofDigest);
}
function valid(record: PendingRegistration): boolean {
  return normalizeLoginEmail(record.email) === record.email &&
    record.name.length > 0 && record.name.length <= 120 && record.name === record.name.trim() &&
    HASH.test(record.passwordHash);
}
export async function sealPendingRegistration(input: {
  secret: string; subjectDigest: string; proofDigest: string; record: PendingRegistration;
}): Promise<string> {
  if (!valid(input.record)) throw new Error('Invalid pending registration data');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const bytes = encoder.encode(JSON.stringify(input.record));
  if (bytes.length > 1024) throw new Error('Pending registration data too large');
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad(input.subjectDigest, input.proofDigest) },
    await encryptionKey(input.secret), bytes,
  );
  const sealed = 'v1.' + toBase64Url(nonce) + '.' + toBase64Url(new Uint8Array(ciphertext));
  if (sealed.length > 4096) throw new Error('Pending registration ciphertext too large');
  return sealed;
}
export async function unsealPendingRegistration(input: {
  secret: string; subjectDigest: string; proofDigest: string; sealed: string;
}): Promise<PendingRegistration | null> {
  if (input.sealed.length > 4096) return null;
  const [version, encodedNonce, encodedData, ...extra] = input.sealed.split('.');
  if (version !== 'v1' || !encodedNonce || !encodedData || extra.length !== 0) return null;
  const nonce = fromBase64Url(encodedNonce);
  const ciphertext = fromBase64Url(encodedData);
  if (nonce?.length !== 12 || !ciphertext || ciphertext.length > 2048) return null;
  try {
    const bytes = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad(input.subjectDigest, input.proofDigest) },
      await encryptionKey(input.secret), ciphertext,
    );
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.email !== 'string' || typeof obj.name !== 'string' || typeof obj.passwordHash !== 'string') return null;
    const record = { email: obj.email, name: obj.name, passwordHash: obj.passwordHash };
    return valid(record) ? record : null;
  } catch { return null; }
}
