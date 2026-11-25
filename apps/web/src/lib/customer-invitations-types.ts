/** OWNER-INVITE-01 DTOs (mirror apps/api/src/customer-invitations). No customer identity anywhere. */
export const INVITATION_STATUSES = ['active', 'accepted', 'revoked', 'expired'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];
export interface InvitationDto { id: string; branchId: string; branchName: string; status: InvitationStatus; createdAt: string; expiresAt: string; revokedAt: string | null; acceptedAt: string | null }
export interface InvitationListDto { invitations: InvitationDto[]; counts: Record<InvitationStatus, number> }
