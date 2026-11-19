import 'server-only';
import type { AssistedInvitePreviewDto } from '@echo-grid-feedback/shared-types';
import { customerApiFetch } from '@/lib/customer-api-client';

/** Only the characters of a compact signed token, bounded; anything else is not an invitation and never reaches the API. */
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9._-]{20,2048}$/;

/**
 * CASHIER-AUTH-02D: what an invitation is, for the signed-in customer, BEFORE they consent: business and branch names and whether it can still
 * be used. Read-only on the server; shows nothing about the cashier. An expired customer session redirects to sign-in and returns here.
 */
export function previewAssistedInvite(token: string): Promise<AssistedInvitePreviewDto> {
  return customerApiFetch<AssistedInvitePreviewDto>(
    '/customer-memberships/join-assisted/preview',
    { method: 'POST', body: JSON.stringify({ inviteToken: token }), cache: 'no-store' },
    `/loyalty/invite/${token}`,
  );
}
