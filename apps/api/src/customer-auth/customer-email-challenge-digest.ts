/**
 * CUSTOMER-AUTH-01D-4b-S2: opaque challenge digest primitives.
 * Domain-separated keyed SHA-256 prevents offline guessing of low-entropy
 * email addresses or short proof codes after a database disclosure.
 *
 * Never persist raw email, raw proof or the HMAC key in challenge rows.
 * The key is supplied by the caller from a dedicated secret binding.
 * This module is not wired to HTTP, delivery or credential issuance.
 */
import type { CustomerAuthChallengePurpose } from '../db/schema/customer-auth-challenges';

const encoder = new TextEncoder();
const MAX_EMAIL_LENGTH = 254;
const MAX_PROOF_LENGTH = 256;

export function normalizeLoginEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_EMAIL_LENGTH ||
    !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(normalized)
  ) return null;
  return normalized;
}

export async function customerChallengeDigest(input: {
  secret: string;
  purpose: CustomerAuthChallengePurpose;
  field: 'subject' | 'proof';
  value: string;
}): Promise<string> {
  if (typeof input.secret !== 'string' || encoder.encode(input.secret).length < 32) {
    throw new Error('Customer challenge HMAC secret is not configured');
  }
  if (input.field === 'subject') {
    if (!normalizeLoginEmail(input.value) || normalizeLoginEmail(input.value) !== input.value) {
      throw new Error('Challenge subject must be a normalized email');
    }
  } else if (
    typeof input.value !== 'string' ||
    input.value.length < 6 ||
    input.value.length > MAX_PROOF_LENGTH
  ) {
    throw new Error('Invalid challenge proof length');
  }
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(input.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const message = encoder.encode(
    `echo-grid/customer-auth-challenge/v1/\\0${input.purpose}/${input.field}/\\0${input.value}`,
  );
  const digest = await crypto.subtle.sign('HMAC', key, message);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
