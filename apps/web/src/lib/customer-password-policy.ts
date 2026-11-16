import 'server-only';

/**
 * The customer password minimum as configured for THIS Worker (CUSTOMER_PASSWORD_MIN_LENGTH, owner decision CA-05, approved
 * 8). It is configuration, never a number written into a screen or an action: the API enforces the same setting and stays
 * authoritative, and this value only lets the web show a hint and refuse an obviously short password before a round trip.
 *
 * Returns null when the setting is absent or not a plain positive integer. Nothing is assumed in that case: the screen shows
 * no hint and the API (which fails closed without its own setting) decides.
 */
export function getCustomerPasswordMinLength(): number | null {
  const raw = process.env.CUSTOMER_PASSWORD_MIN_LENGTH;
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,2}$/.test(raw)) return null;
  return Number(raw);
}

/** Length as a person counts it (code points), matching the API policy, so an emoji is one character not two. */
export function passwordLength(password: string): number {
  return Array.from(password.normalize('NFKC')).length;
}
