/**
 * Masks a phone number (E.164) for platform moderation views: keeps the
 * country-code prefix and the last two digits, hides the rest. Short or
 * malformed values are fully masked. This is display masking only; the full
 * number is never returned by the moderation list.
 */
export function maskPhone(phone: string): string {
  if (phone.length < 8) return '*'.repeat(Math.max(phone.length, 4));
  return `${phone.slice(0, 4)}${'*'.repeat(phone.length - 6)}${phone.slice(-2)}`;
}
