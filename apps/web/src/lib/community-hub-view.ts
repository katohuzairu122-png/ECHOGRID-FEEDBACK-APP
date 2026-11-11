import type { CommunityMembershipDto } from './community-hub-types';

/** What the membership card should say. `absent` means the API returned no membership: not a zero-point member. */
export type MembershipKind = 'absent' | 'active' | 'left' | 'suspended';

export function membershipKind(membership: CommunityMembershipDto | null): MembershipKind {
  return membership ? membership.status : 'absent';
}

/** The date that explains the current status, taken only from the recorded membership timestamps. */
export function membershipStatusDate(membership: CommunityMembershipDto | null): string | null {
  if (!membership) return null;
  if (membership.status === 'left') return membership.leftAt;
  if (membership.status === 'suspended') return membership.suspendedAt;
  return membership.joinedAt;
}
