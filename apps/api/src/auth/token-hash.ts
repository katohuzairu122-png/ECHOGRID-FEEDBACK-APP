/**
 * One-way hash for storing refresh tokens at rest. Plain fast SHA-256 (not
 * PBKDF2) is correct here, unlike password hashing: the input is a
 * high-entropy signed JWT, not a low-entropy human password, so there is no
 * dictionary/brute-force risk to slow down against -- the hash only needs to
 * keep a stolen database dump from handing out live bearer tokens directly.
 */
export async function hashToken(rawToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawToken));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
