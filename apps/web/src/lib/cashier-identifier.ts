/**
 * Decides what a cashier typed, pasted or scanned into the single customer field (D-C2 design, section 4.7).
 * Only two shapes are accepted, and nothing else is guessed:
 *   - a customer QR token: a signed token of three base64url parts separated by dots (what a camera or a
 *     connected scanner reads from the customer's QR code);
 *   - a phone number with its country code (an optional leading + or 00, then digits, with spaces, dashes,
 *     dots and brackets ignored).
 * Whitespace and control characters (some scanners add them) are stripped first. A number typed without a
 * country code is refused rather than guessed, because the server matches the exact E.164 number.
 */
export type CashierInput =
  | { kind: 'token'; value: string }
  | { kind: 'phone'; value: string }
  | { kind: 'invalid'; reason: 'empty' | 'countryCode' | 'unrecognized' };

const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const E164 = /^\+[1-9]\d{7,14}$/;
const PHONE_PUNCTUATION = /[\s().-]/g;

export function classifyCashierInput(raw: string): CashierInput {
  const cleaned = raw.replace(/[\s\p{Cc}]/gu, '');
  if (!cleaned) return { kind: 'invalid', reason: 'empty' };

  // Phone first: a number written with dots (555.123.4567) has the same three-part shape as a token, but a real
  // token always contains letters. Punctuation people type in numbers is ignored; letters never are.
  const compact = raw.replace(/\p{Cc}/gu, '').replace(PHONE_PUNCTUATION, '');
  if (/^\+?\d+$/.test(compact)) {
    const international = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
    if (E164.test(international)) return { kind: 'phone', value: international };
    if (!international.startsWith('+')) return { kind: 'invalid', reason: 'countryCode' };
    return { kind: 'invalid', reason: 'unrecognized' };
  }

  if (TOKEN_SHAPE.test(cleaned)) return { kind: 'token', value: cleaned };
  return { kind: 'invalid', reason: 'unrecognized' };
}
