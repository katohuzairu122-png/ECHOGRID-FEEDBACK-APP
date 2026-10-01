'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';

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

export async function resendInvitationAction(id: string) { await mutate(`/team/invitations/${id}/resend`, 'POST'); }
export async function cancelInvitationAction(id: string) { await mutate(`/team/invitations/${id}`, 'DELETE'); }
export async function revokeTeamAccessAction(id: string) { await mutate(`/team/members/${id}`, 'DELETE'); }
export async function updateTeamAccessAction(id: string, formData: FormData) {
  await mutate(`/team/members/${id}`, 'PATCH', { roleId: String(formData.get('roleId') ?? ''), branchId: String(formData.get('branchId') ?? '') || null });
}
export async function acceptInvitationAction(
  token: string,
  _prevState: TeamActionState,
): Promise<TeamActionState> {
  try {
    await apiFetch('/team/invitations/accept', {
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

  revalidatePath('/dashboard');
  redirect('/dashboard');
}
