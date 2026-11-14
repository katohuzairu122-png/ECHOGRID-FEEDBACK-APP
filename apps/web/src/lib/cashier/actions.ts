'use server';

import { redirect } from 'next/navigation';
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
import {
  ensureCashierAccess,
  postCashierAuth,
  type CashierChoiceDto,
  type CashierLoginResponse,
} from './auth-api';
import {
  clearCashierSession,
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

/** Step 2: choose the business (and branch) to serve; the API re-checks eligibility now. */
export async function cashierSelectAction(
  _prev: CashierLoginState,
  form: FormData,
): Promise<CashierLoginState> {
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
async function withCashier<T>(work: () => Promise<T>): Promise<T> {
  if (!(await ensureCashierAccess())) redirect(LOGIN);
  return runInCashierSurface(work);
}

export async function cashierServeAction(prev: StaffQrState, form: FormData): Promise<StaffQrState> {
  return withCashier(() => staffUnifiedQrAction(prev, form));
}

export async function cashierLookupRedemptionAction(
  prev: RedemptionLookupState,
  form: FormData,
): Promise<RedemptionLookupState> {
  return withCashier(() => lookupRedemptionAction(prev, form));
}

export async function cashierConfirmRedemptionAction(code: string): Promise<LoyaltyTransactionDto> {
  return withCashier(() => confirmRedemptionAction(code));
}
