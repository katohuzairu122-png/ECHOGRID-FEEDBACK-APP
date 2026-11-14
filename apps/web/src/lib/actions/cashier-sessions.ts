'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';

export interface CashierSessionsActionState {
  status?: 'revoked' | 'revokedAll' | 'failed';
}

const PAGE = '/dashboard/cashier';

/**
 * CASHIER-PWA-01 C6, dashboard side. Ordinary staff-session calls to the business-scoped cashier session routes; the API
 * enforces membership, permission (business:manage_settings, business-wide) and that only THIS business's cashier
 * sessions can be listed or ended. Nothing here is reachable from a cashier token.
 */
async function run(work: (businessId: string) => Promise<CashierSessionsActionState>): Promise<CashierSessionsActionState> {
  try {
    const business = await getActiveBusiness();
    if (!business) return { status: 'failed' };
    const result = await work(business.id);
    revalidatePath(PAGE);
    return result;
  } catch (err) {
    rethrowControlFlow(err);
    if (err instanceof ApiError && err.status === 404) revalidatePath(PAGE); // already gone: the list refreshes
    return { status: 'failed' };
  }
}

export async function revokeCashierSessionAction(
  _prev: CashierSessionsActionState,
  form: FormData,
): Promise<CashierSessionsActionState> {
  const sessionId = String(form.get('sessionId') ?? '');
  return run(async (businessId) => {
    await apiFetch(`/cashier-sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', businessId });
    return { status: 'revoked' };
  });
}

export async function revokeAllCashierSessionsAction(): Promise<CashierSessionsActionState> {
  return run(async (businessId) => {
    await apiFetch('/cashier-sessions/revoke-all', { method: 'POST', businessId });
    return { status: 'revokedAll' };
  });
}
