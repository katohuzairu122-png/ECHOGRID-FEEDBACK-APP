/**
 * Timing-safe comparison helpers. A plain === or a byte loop with an early
 * return leaks how many leading bytes matched via response timing -- use
 * these anywhere a value derived from a secret (a password hash, a token
 * hash) is compared against user-supplied input.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    // Bounds are guaranteed by the loop condition and the length check
    // above; noUncheckedIndexedAccess can't see that, hence the assertions.
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  return constantTimeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b));
}
