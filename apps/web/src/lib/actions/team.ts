'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import { ACTIVE_BUSINESS_COOKIE } from '@/lib/cookies';

export type TeamActionState = { error?: string; success?: string };
const teamPath = '/dashboard/settings/team';

export async function inviteTeamMemberAction(_state: TeamActionState, formData: FormData): Promise<TeamActionState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'No active business.' };
  try {
    await apiFetch('/team/invitations', { method: 'POST', businessId: business.id, body: JSON.stringify({ email: String(formData.get('email') ?? ''), roleId: String(formData.get('roleId') ?? ''), branchId: String(formData.get('branchId') ?? '') || null }) });
    revalidatePath(teamPath);
    return { success: 'Invitation sent.' };
  } catch (error) { return { error: error instanceof ApiError ? error.message : 'Could not send invitation.' }; }
}

async function mutate(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) {
  const business = await getActiveBusiness();
  if (!business) throw new Error('No active business.');
  await apiFetch(path, { method, businessId: business.id, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  revalidatePath(teamPath);
}

async function mutateWithState(
  path: string,
  method: 'POST' | 'DELETE',
  success: string,
): Promise<TeamActionState> {
  try {
    await mutate(path, method);
    return { success };
  } catch (error) {
    return {
      error: error instanceof ApiError ? error.message : 'The action could not be completed. Please try again.',
    };
  }
}

export async function resendInvitationAction(id: string, _state: TeamActionState) {
  return mutateWithState(`/team/invitations/${id}/resend`, 'POST', 'Invitation resent.');
}
export async function cancelInvitationAction(id: string, _state: TeamActionState) {
  return mutateWithState(`/team/invitations/${id}`, 'DELETE', 'Invitation cancelled.');
}
export async function revokeTeamAccessAction(id: string, _state: TeamActionState) {
  return mutateWithState(`/team/members/${id}`, 'DELETE', 'Access revoked.');
}
export async function updateTeamAccessAction(id: string, formData: FormData) {
  await mutate(`/team/members/${id}`, 'PATCH', { roleId: String(formData.get('roleId') ?? ''), branchId: String(formData.get('branchId') ?? '') || null });
}
export async function acceptInvitationAction(
  token: string,
  _prevState: TeamActionState,
): Promise<TeamActionState> {
  let accepted: { businessId: string };
  try {
    accepted = await apiFetch<{ businessId: string }>('/team/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  } catch (error) {
    return {
      error: error instanceof ApiError
        ? error.message
        : 'Could not accept the invitation. Please try again.',
    };
  }

  (await cookies()).set(ACTIVE_BUSINESS_COOKIE, accepted.businessId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 365 * 24 * 60 * 60,
  });
  revalidatePath('/dashboard', 'layout');
  redirect('/dashboard');
}
