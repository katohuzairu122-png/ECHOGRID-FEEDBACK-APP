/**
 * Human-typeable code a customer shows staff at the counter to redeem a
 * reward -- distinct from customer-auth/otp.ts's generateOtpCode (that one
 * is numeric-only, sent via SMS and typed on a phone keypad; this one is
 * read off a screen and typed into a staff POS/dashboard, so legibility
 * under a quick glance matters more than a fixed digit count).
 *
 * Alphabet excludes visually ambiguous characters (0/O, 1/I/L) -- a
 * misread code should fail loudly (code not found) rather than silently
 * redeem the wrong reward.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export function generateRedemptionCode(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(CODE_LENGTH));
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return code;
}
