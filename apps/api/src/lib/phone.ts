/**
 * E.164 normalization (CUSTOMER-PHONE-01). Accepts what people actually type (spaces, dashes, dots, brackets, a leading
 * "00" instead of "+") and returns canonical E.164, or null. It never guesses a country: a number without its country
 * code is rejected rather than interpreted, because a wrong guess would verify the wrong person's phone.
 */
const E164 = /^\+[1-9][0-9]{6,14}$/;

export function normalizeE164(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 40) return null;
  let value = raw.trim().replace(/[\s\-.()]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  return E164.test(value) ? value : null;
}
