/**
 * The sign-in name for a new cashier is made FROM THE NAME the owner types, so the owner never has to learn the username rules
 * (3 to 32 characters, lowercase letters, digits, dot, underscore, hyphen; first character a letter or digit; see the API's USERNAME_PATTERN).
 * "Amína O'Neil" gives "amina.o.neil". A suffix (digits) is appended when the name is already taken. Pure and deterministic.
 */
const MAX = 32;

export function suggestCashierUsername(name: string, suffix = ''): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  let stem = base || 'cashier';
  if (stem.length + suffix.length < 3) stem = `${stem}.cashier`;
  return stem.slice(0, MAX - suffix.length).replace(/\.+$/, '') + suffix;
}
