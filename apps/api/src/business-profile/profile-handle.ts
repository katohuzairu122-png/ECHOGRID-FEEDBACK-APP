/**
 * BDPN-01B part 1: the opaque public handle of a business profile (decision D-10, BDPN-01A 4.4).
 * 16 random bytes from a cryptographically secure source, base64url without padding (22 characters). It is generated once
 * when the publication record is created, and is never derived from the business id, a slug, a timestamp or a sequence.
 * The caller retries on a unique-violation, which is the only collision handling needed at 128 bits.
 */
export const PROFILE_HANDLE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function newProfileHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isProfileHandle(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_HANDLE_PATTERN.test(value);
}
