'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ApiError } from '../api-error';
import { rethrowControlFlow } from '../rethrow-control-flow';
import { staffUnifiedQrAction, type StaffQrState } from '../actions/unified-qr';
import {
  lookupRedemptionAction,
  confirmRedemptionAction,
  type RedemptionLookupState,
} from '../actions/loyalty';
import type { LoyaltyTransactionDto } from '@echo-grid-feedback/shared-types';
import { runInCashierSurface } from './surface';
import { requireCashierOrigin } from './host-guard';
import {
  ensureCashierAccess,
  postCashierAuth,
  type CashierChoiceDto,
  type CashierLoginResponse,
} from './auth-api';
import {
  clearCashierSession,
  getCashierContext,
  getCashierRefreshToken,
  getCashierSelectionTicket,
  setCashierSelectionTicket,
  setCashierSession,
  type CashierSessionPayload,
} from './session';

const HOME = '/cashier';
const LOGIN = '/cashier/login';

export interface CashierLoginState {
  error?: 'credentials' | 'access' | 'expired' | 'unavailable';
  /** Present when the user must pick where to serve (the ticket itself stays in an httpOnly cookie). */
  choices?: CashierChoiceDto[];
}

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const label = (form: FormData) => text(form, 'deviceLabel').slice(0, 80) || undefined;

function failureState(err: unknown): CashierLoginState {
  rethrowControlFlow(err);
  if (err instanceof ApiError) {
    if (err.code === 'INVALID_CREDENTIALS') return { error: 'credentials' };
    if (err.code === 'CASHIER_ACCESS_DENIED' || err.code === 'ACCOUNT_INACTIVE') return { error: 'access' };
    if (err.code === 'CASHIER_SELECTION_INVALID') return { error: 'expired' };
    if (err.status === 429) return { error: 'unavailable' };
  }
  return { error: 'unavailable' };
}

/** Step 1: the same staff credentials as the web app, but a separate cashier session. */
export async function cashierLoginAction(
  _prev: CashierLoginState,
  form: FormData,
): Promise<CashierLoginState> {
  await requireCashierOrigin();
  try {
    const result = await postCashierAuth<CashierLoginResponse>('login', {
      email: text(form, 'email'),
      password: String(form.get('password') ?? ''),
      deviceLabel: label(form),
    });
    if (result.status === 'authenticated') {
      await setCashierSession(result as CashierSessionPayload);
      redirect(HOME);
    }
    await setCashierSelectionTicket(result.ticket);
    return { choices: result.choices };
  } catch (err) {
    return failureState(err);
  }
}

/**
 * CASHIER-AUTH-02B: sign-in for a business-managed cashier (business code + username + password; no email). Same result
 * shape as the email sign-in, so the branch-selection step below is shared and an account with several branches picks one.
 */
export async function cashierManagedLoginAction(
  _prev: CashierLoginState,
  form: FormData,
): Promise<CashierLoginState> {
  await requireCashierOrigin();
  try {
    const result = await postCashierAuth<CashierLoginResponse>('managed-login', {
      businessCode: text(form, 'businessCode'),
      username: text(form, 'username'),
      password: String(form.get('password') ?? ''),
      deviceLabel: label(form),
    });
    if (result.status === 'authenticated') {
      await setCashierSession(result as CashierSessionPayload);
      redirect(HOME);
    }
    await setCashierSelectionTicket(result.ticket);
    return { choices: result.choices };
  } catch (err) {
    return failureState(err);
  }
}

/** Step 2: choose the business (and branch) to serve; the API re-checks eligibility now. */
export async function cashierSelectAction(
  _prev: CashierLoginState,
  form: FormData,
): Promise<CashierLoginState> {
  await requireCashierOrigin();
  const ticket = await getCashierSelectionTicket();
  if (!ticket) return { error: 'expired' };
  const branchId = text(form, 'branchId');
  try {
    const result = await postCashierAuth<{ status: 'authenticated' } & CashierSessionPayload>('session', {
      ticket,
      businessId: text(form, 'businessId'),
      ...(branchId ? { branchId } : {}),
      deviceLabel: label(form),
    });
    await setCashierSession(result);
    redirect(HOME);
  } catch (err) {
    return failureState(err);
  }
}

/** Ends THIS cashier session on the server (best effort) and clears the cashier cookies. Never touches staff cookies. */
export async function cashierLogoutAction(): Promise<void> {
  await requireCashierOrigin();
  const refreshToken = await getCashierRefreshToken();
  if (refreshToken) await postCashierAuth('logout', { refreshToken }).catch(() => undefined);
  await clearCashierSession();
  redirect(LOGIN);
}

/**
 * Serve actions: the existing Serve Customers server actions, run under the cashier credentials. Each wrapper first
 * makes sure a cashier access token exists (refreshing in action context, where cookies may be written), and sends the
 * user to the cashier sign-in when the session is gone. Nothing here widens what the cashier token may call.
 */
async function withCashier<T>(work: () => Promise<T>, expected?: { branchId: string | null }): Promise<T> {
  await requireCashierOrigin();
  if (!(await ensureCashierAccess())) redirect(LOGIN);
  if (expected !== undefined) {
    // CASHIER-AUTH-02C: the screen submitting this action was drawn for one branch. If the session moved to another branch since
    // (a switch in another window), do nothing and reload the counter on the real branch. The API independently refuses any
    // request whose branch differs from the signed session binding; this just spares the cashier a confusing error.
    const ctx = await getCashierContext();
    if (ctx && (ctx.branchId ?? '') !== (expected.branchId ?? '')) redirect(HOME);
  }
  return runInCashierSurface(work);
}

export async function cashierServeAction(prev: StaffQrState, form: FormData): Promise<StaffQrState> {
  // The form carries the branch the screen was drawn for (see StaffQrMenu's hidden branchId).
  return withCashier(() => staffUnifiedQrAction(prev, form), form.has('branchId') ? { branchId: text(form, 'branchId') || null } : undefined);
}

/** `expectedBranchId` is bound by the redeem page (`.bind(null, branchId)`): the branch this screen was drawn for. */
export async function cashierLookupRedemptionAction(
  expectedBranchId: string | null,
  prev: RedemptionLookupState,
  form: FormData,
): Promise<RedemptionLookupState> {
  return withCashier(() => lookupRedemptionAction(prev, form), { branchId: expectedBranchId });
}

export async function cashierConfirmRedemptionAction(expectedBranchId: string | null, code: string): Promise<LoyaltyTransactionDto> {
  return withCashier(() => confirmRedemptionAction(code), { branchId: expectedBranchId });
}

export interface CashierBranchesState {
  status?: 'ready' | 'failed';
  branches?: { id: string; name: string }[];
  currentBranchId?: string | null;
}

export interface CashierBranchSwitchState {
  status?: 'switched' | 'unchanged' | 'denied' | 'conflict' | 'unavailable';
  branchName?: string | null;
}

/** Refusals that mean this cashier session is over: sign in again. Anything else is retryable or a plain refusal. */
const SESSION_ENDED = new Set(['INVALID_REFRESH_TOKEN', 'ACCOUNT_INACTIVE', 'CASHIER_ACCESS_REVOKED']);

async function endSessionAndSignIn(err: unknown): Promise<void> {
  if (err instanceof ApiError && err.code && SESSION_ENDED.has(err.code)) {
    await clearCashierSession();
    redirect(`${LOGIN}?reason=session`);
  }
}

/**
 * CASHIER-AUTH-02C: the branches this session may switch to, for the switch dialog. Advisory and read-only: the server re-checks
 * everything on the switch itself. The cashier cookies are only ever read here; nothing is rotated.
 */
export async function cashierListBranchesAction(): Promise<CashierBranchesState> {
  await requireCashierOrigin();
  const refreshToken = await getCashierRefreshToken();
  if (!refreshToken) redirect(LOGIN);
  try {
    const r = await postCashierAuth<{ current: { id: string; name: string } | null; branches: { id: string; name: string }[] }>(
      'branches',
      { refreshToken },
    );
    return { status: 'ready', branches: r.branches, currentBranchId: r.current?.id ?? null };
  } catch (err) {
    rethrowControlFlow(err);
    await endSessionAndSignIn(err);
    return { status: 'failed' };
  }
}

/**
 * CASHIER-AUTH-02C: switches the active branch of THIS cashier session, without a password. The API replaces the session (new
 * tokens bound to the new branch), and the new cookies are stored here; the previous branch's credentials stop working at once.
 * `fromBranchId` is the branch this window believes is active, so a stale window is a clear conflict, never a silent change.
 */
export async function cashierSwitchBranchAction(
  _prev: CashierBranchSwitchState,
  form: FormData,
): Promise<CashierBranchSwitchState> {
  await requireCashierOrigin();
  const refreshToken = await getCashierRefreshToken();
  if (!refreshToken) redirect(LOGIN);
  const branchId = text(form, 'branchId');
  const fromBranchId = text(form, 'fromBranchId');
  if (!branchId) return { status: 'denied' };
  try {
    const r = await postCashierAuth<{ switched: boolean; accessToken?: string; refreshToken?: string; session: CashierSessionPayload['session'] }>(
      'switch-branch',
      { refreshToken, branchId, ...(fromBranchId ? { fromBranchId } : {}) },
    );
    if (r.switched && r.accessToken && r.refreshToken) {
      await setCashierSession({ accessToken: r.accessToken, refreshToken: r.refreshToken, session: r.session });
      revalidatePath('/cashier', 'layout');
      return { status: 'switched', branchName: r.session.branchName ?? null };
    }
    return { status: 'unchanged', branchName: r.session.branchName ?? null };
  } catch (err) {
    rethrowControlFlow(err);
    await endSessionAndSignIn(err);
    if (err instanceof ApiError) {
      if (err.code === 'CASHIER_ACCESS_DENIED' || err.code === 'CASHIER_SWITCH_NOT_AVAILABLE') return { status: 'denied' };
      if (err.code === 'CASHIER_SWITCH_CONFLICT' || err.code === 'REFRESH_TOKEN_ROTATED') return { status: 'conflict' };
    }
    return { status: 'unavailable' };
  }
}
