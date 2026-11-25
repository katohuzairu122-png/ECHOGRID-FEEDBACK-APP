'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';
import { BUSINESS_CLOSURE_REAUTH_COOKIE } from '@/lib/cookies';

export type BusinessClosureActionState = {
  status?: 'reauthenticated' | 'filed' | 'withdrawn' | 'failed' | 'reauthRequired';
  /** The API error code for a failed action; the view maps it to a message. */
  error?: string;
};

const PAGE = '/dashboard/settings/closure';
const REAUTH_TTL_SECONDS = 300;

/**
 * BIZ-CLOSE-01, dashboard side: ordinary staff-session calls to `/business-closure`. The API enforces membership, the Owner-only
 * `business:delete` permission, business-wide access, the fresh password proof and the typed confirmation; this layer forwards the proof
 * from an httpOnly cookie scoped to this page and reports failures by code. Nothing here is reachable from a cashier token.
 */
async function run(
  work: (businessId: string, proof: Record<string, string>) => Promise<BusinessClosureActionState>,
): Promise<BusinessClosureActionState> {
  try {
    const business = await getActiveBusiness();
    if (!business) return { status: 'failed' };
    const proof = (await cookies()).get(BUSINESS_CLOSURE_REAUTH_COOKIE)?.value;
    const result = await work(business.id, proof ? { 'X-Reauth-Proof': proof } : {});
    revalidatePath(PAGE);
    return result;
  } catch (err) {
    rethrowControlFlow(err);
    if (err instanceof ApiError) {
      if (err.code === 'REAUTH_REQUIRED') return { status: 'reauthRequired' };
      return { status: 'failed', ...(err.code ? { error: err.code } : {}) };
    }
    return { status: 'failed' };
  }
}

export async function closureReauthAction(_prev: BusinessClosureActionState, form: FormData): Promise<BusinessClosureActionState> {
  const password = String(form.get('password') ?? '');
  return run(async (businessId) => {
    const res = await apiFetch<{ proof: string }>('/business-closure/reauth', { method: 'POST', businessId, body: JSON.stringify({ password }) });
    (await cookies()).set(BUSINESS_CLOSURE_REAUTH_COOKIE, res.proof, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/dashboard/settings/closure', maxAge: REAUTH_TTL_SECONDS,
    });
    return { status: 'reauthenticated' };
  });
}

export async function fileClosureRequestAction(_prev: BusinessClosureActionState, form: FormData): Promise<BusinessClosureActionState> {
  const confirmBusinessName = String(form.get('confirmBusinessName') ?? '');
  return run(async (businessId, proof) => {
    await apiFetch('/business-closure/requests', { method: 'POST', businessId, headers: proof, body: JSON.stringify({ confirmBusinessName }) });
    return { status: 'filed' };
  });
}

export async function withdrawClosureRequestAction(_prev: BusinessClosureActionState): Promise<BusinessClosureActionState> {
  return run(async (businessId, proof) => {
    await apiFetch('/business-closure/requests/withdraw', { method: 'POST', businessId, headers: proof, body: JSON.stringify({}) });
    return { status: 'withdrawn' };
  });
}
