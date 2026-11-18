'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';
import { CASHIER_ADMIN_REAUTH_COOKIE } from '@/lib/cookies';

export type CashierAccountsStatus =
  | 'reauthenticated' | 'created' | 'updated' | 'credentialReset' | 'codeRotated' | 'failed' | 'reauthRequired';

export interface CashierAccountsActionState {
  status?: CashierAccountsStatus;
  /** The API error code for a failed action; the view maps it to a message. */
  error?: string;
  /** Shown ONCE, held only in this action result: never stored, cached or logged by this app. */
  credential?: { username?: string; password: string; cashierCode?: string };
}

const PAGE = '/dashboard/cashier/accounts';
const REAUTH_TTL_SECONDS = 300;
const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

/**
 * CASHIER-AUTH-02B, dashboard side. Ordinary staff-session calls to the business-scoped `/cashier-accounts` routes. The API
 * enforces membership, `cashier:manage`, business-wide access and the fresh-password proof; this layer forwards the proof
 * (from an httpOnly cookie) and reports failures by code. Nothing here is reachable from a cashier token.
 */
async function run(
  work: (businessId: string, proof: Record<string, string>) => Promise<CashierAccountsActionState>,
): Promise<CashierAccountsActionState> {
  try {
    const business = await getActiveBusiness();
    if (!business) return { status: 'failed' };
    const proof = (await cookies()).get(CASHIER_ADMIN_REAUTH_COOKIE)?.value;
    const result = await work(business.id, proof ? { 'X-Reauth-Proof': proof } : {});
    revalidatePath(PAGE);
    return result;
  } catch (err) {
    rethrowControlFlow(err);
    if (err instanceof ApiError) {
      if (err.code === 'REAUTH_REQUIRED') return { status: 'reauthRequired' };
      if (err.status === 404) revalidatePath(PAGE); // already gone: the list refreshes
      return { status: 'failed', ...(err.code ? { error: err.code } : {}) };
    }
    return { status: 'failed' };
  }
}

/** Re-enter the administrator password; on success a 5 minute proof is kept in an httpOnly cookie. */
export async function cashierReauthAction(_prev: CashierAccountsActionState, form: FormData): Promise<CashierAccountsActionState> {
  const password = String(form.get('password') ?? '');
  return run(async (businessId) => {
    const res = await apiFetch<{ proof: string }>('/cashier-accounts/reauth', { method: 'POST', businessId, body: JSON.stringify({ password }) });
    (await cookies()).set(CASHIER_ADMIN_REAUTH_COOKIE, res.proof, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/dashboard/cashier', maxAge: REAUTH_TTL_SECONDS,
    });
    return { status: 'reauthenticated' };
  });
}

export async function createCashierAccountAction(_prev: CashierAccountsActionState, form: FormData): Promise<CashierAccountsActionState> {
  const password = String(form.get('password') ?? '');
  const body = {
    username: text(form, 'username'), displayName: text(form, 'displayName'),
    accessMode: text(form, 'accessMode'), branchIds: form.getAll('branchId').map(String),
    ...(password ? { password } : {}),
  };
  return run(async (businessId, proof) => {
    const res = await apiFetch<{ account: { username: string }; initialPassword: string | null; cashierCode: string }>('/cashier-accounts', {
      method: 'POST', businessId, headers: proof, body: JSON.stringify(body),
    });
    return {
      status: 'created',
      credential: { username: res.account.username, password: res.initialPassword ?? '', cashierCode: res.cashierCode },
    };
  });
}

export async function setCashierBranchesAction(_prev: CashierAccountsActionState, form: FormData): Promise<CashierAccountsActionState> {
  const id = text(form, 'accountId');
  const body = { accessMode: text(form, 'accessMode'), branchIds: form.getAll('branchId').map(String) };
  return run(async (businessId, proof) => {
    await apiFetch(`/cashier-accounts/${encodeURIComponent(id)}/branches`, { method: 'PUT', businessId, headers: proof, body: JSON.stringify(body) });
    return { status: 'updated' };
  });
}

export async function resetCashierCredentialAction(_prev: CashierAccountsActionState, form: FormData): Promise<CashierAccountsActionState> {
  const id = text(form, 'accountId');
  return run(async (businessId, proof) => {
    const res = await apiFetch<{ initialPassword: string | null }>(`/cashier-accounts/${encodeURIComponent(id)}/reset-credential`, {
      method: 'POST', businessId, headers: proof, body: JSON.stringify({}),
    });
    return { status: 'credentialReset', credential: { username: text(form, 'username'), password: res.initialPassword ?? '' } };
  });
}

const STATUS_ACTIONS = new Set(['disable', 'enable', 'revoke', 'revoke-sessions']);

/** Disable, enable, revoke the account, or sign out all of its sessions. The action name is checked against a fixed list. */
export async function cashierAccountStatusAction(_prev: CashierAccountsActionState, form: FormData): Promise<CashierAccountsActionState> {
  const id = text(form, 'accountId');
  const action = text(form, 'action');
  if (!STATUS_ACTIONS.has(action)) return { status: 'failed' };
  return run(async (businessId, proof) => {
    await apiFetch(`/cashier-accounts/${encodeURIComponent(id)}/${action}`, { method: 'POST', businessId, headers: proof });
    return { status: 'updated' };
  });
}

export async function rotateCashierCodeAction(): Promise<CashierAccountsActionState> {
  return run(async (businessId, proof) => {
    await apiFetch('/cashier-accounts/business-code/rotate', { method: 'POST', businessId, headers: proof });
    return { status: 'codeRotated' };
  });
}
