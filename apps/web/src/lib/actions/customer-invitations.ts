'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';

export interface InvitationActionState {
  status?: 'created' | 'revoked' | 'failed';
  /** The shareable link, shown once to the owner who just created it. Never logged. */
  inviteUrl?: string;
  expiresAt?: string;
  error?: string;
}

const PAGE = '/dashboard/cashier/invitations';

/**
 * OWNER-INVITE-01, dashboard side: ordinary staff-session calls to `/customer-invitations`. The API enforces membership, `cashier:manage`,
 * business-wide access, the branch belonging to this business, rate limiting and audit. Nothing here is reachable from a cashier token.
 */
async function run(work: (businessId: string) => Promise<InvitationActionState>): Promise<InvitationActionState> {
  try {
    const business = await getActiveBusiness();
    if (!business) return { status: 'failed' };
    const result = await work(business.id);
    revalidatePath(PAGE);
    return result;
  } catch (err) {
    rethrowControlFlow(err);
    if (err instanceof ApiError) return { status: 'failed', ...(err.status === 429 ? { error: 'RATE_LIMITED' } : err.code ? { error: err.code } : {}) };
    return { status: 'failed' };
  }
}

export async function createInvitationAction(_prev: InvitationActionState, form: FormData): Promise<InvitationActionState> {
  const branchId = String(form.get('branchId') ?? '');
  const hours = Number(form.get('expiresInHours') ?? 24);
  return run(async (businessId) => {
    const res = await apiFetch<{ inviteUrl: string; expiresAt: string }>('/customer-invitations', {
      method: 'POST', businessId, cache: 'no-store',
      body: JSON.stringify({ branchId, expiresInHours: Number.isInteger(hours) ? hours : 24 }),
    });
    return { status: 'created', inviteUrl: res.inviteUrl, expiresAt: res.expiresAt };
  });
}

export async function revokeInvitationAction(_prev: InvitationActionState, form: FormData): Promise<InvitationActionState> {
  const id = String(form.get('invitationId') ?? '');
  return run(async (businessId) => {
    await apiFetch(`/customer-invitations/${encodeURIComponent(id)}/revoke`, { method: 'POST', businessId, cache: 'no-store', body: JSON.stringify({}) });
    return { status: 'revoked' };
  });
}
