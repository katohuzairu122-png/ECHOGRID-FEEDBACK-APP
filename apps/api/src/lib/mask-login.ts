/**
 * PROF-01: a masked sign-in handle for the "signed in as" chip. Enough for a person to recognise which account they are in,
 * never enough to read the full address or number back from a screenshot.
 */
export function maskLogin(input: { email?: string | null; phone?: string | null }): string | null {
  const email = input.email?.trim();
  if (email && email.includes('@')) {
    const [local = '', domain = ''] = email.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  const phone = input.phone?.trim();
  if (phone && phone.length >= 5) return `${phone.slice(0, 2)}${'•'.repeat(Math.max(3, phone.length - 4))}${phone.slice(-2)}`;
  return null;
}
