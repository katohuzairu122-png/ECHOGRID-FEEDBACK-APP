import type { CustomerProfileDto } from '@echo-grid-feedback/shared-types';

/** Up to two initials from a name ("Amina Kato" -> "AK"); "?" when there is nothing to show. Works for any script. */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = Array.from(parts[0] ?? '')[0] ?? '';
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1] ?? '')[0] ?? '') : '';
  return (first + last).toLocaleUpperCase() || '?';
}

/** The name shown for a customer: their chosen display name, else the account name, else nothing. */
export function identityName(profile: Pick<CustomerProfileDto, 'displayName' | 'fullName'> | null): string | null {
  return profile?.displayName ?? profile?.fullName ?? null;
}
