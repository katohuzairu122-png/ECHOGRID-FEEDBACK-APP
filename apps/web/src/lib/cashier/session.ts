import 'server-only';
import { cookies } from 'next/headers';
import {
  CASHIER_ACCESS_COOKIE,
  CASHIER_CONTEXT_COOKIE,
  CASHIER_REFRESH_COOKIE,
  CASHIER_SELECT_COOKIE,
} from '../cookies';

// Matches apps/api: the cashier access token lives 15 minutes, the cashier refresh token 12 hours (sliding: every
// rotation issues a fresh 12 hours; see CASHIER_REFRESH_TOKEN_TTL_SECONDS).
const ACCESS_MAX_AGE = 15 * 60;
const REFRESH_MAX_AGE = 12 * 60 * 60;
const SELECT_MAX_AGE = 5 * 60;

export interface CashierContext {
  businessId: string;
  businessName: string | null;
  branchId: string | null;
  branchName: string | null;
  deviceLabel: string | null;
}

export interface CashierSessionPayload {
  accessToken: string;
  refreshToken: string;
  session: {
    businessId: string;
    branchId: string | null;
    deviceLabel: string | null;
    businessName?: string | null;
    branchName?: string | null;
  };
}

const options = (maxAge: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  // Scoped to the cashier app's own paths: the cashier cookies are not even sent to any other route.
  path: '/cashier',
  maxAge,
});

export async function setCashierSession(payload: CashierSessionPayload): Promise<void> {
  const store = await cookies();
  store.set(CASHIER_ACCESS_COOKIE, payload.accessToken, options(ACCESS_MAX_AGE));
  store.set(CASHIER_REFRESH_COOKIE, payload.refreshToken, options(REFRESH_MAX_AGE));
  const ctx: CashierContext = {
    businessId: payload.session.businessId,
    businessName: payload.session.businessName ?? null,
    branchId: payload.session.branchId,
    branchName: payload.session.branchName ?? null,
    deviceLabel: payload.session.deviceLabel,
  };
  store.set(CASHIER_CONTEXT_COOKIE, JSON.stringify(ctx), options(REFRESH_MAX_AGE));
  store.delete({ name: CASHIER_SELECT_COOKIE, path: '/cashier' });
}

export async function clearCashierSession(): Promise<void> {
  const store = await cookies();
  for (const name of [CASHIER_ACCESS_COOKIE, CASHIER_REFRESH_COOKIE, CASHIER_CONTEXT_COOKIE, CASHIER_SELECT_COOKIE]) {
    store.delete({ name, path: '/cashier' });
  }
}

export async function getCashierAccessToken(): Promise<string | undefined> {
  return (await cookies()).get(CASHIER_ACCESS_COOKIE)?.value;
}
export async function getCashierRefreshToken(): Promise<string | undefined> {
  return (await cookies()).get(CASHIER_REFRESH_COOKIE)?.value;
}
export async function hasCashierSession(): Promise<boolean> {
  return (await cookies()).has(CASHIER_REFRESH_COOKIE);
}

/** Display/routing context only. A malformed or edited cookie yields null; the signed token remains the authority. */
export async function getCashierContext(): Promise<CashierContext | null> {
  const raw = (await cookies()).get(CASHIER_CONTEXT_COOKIE)?.value;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CashierContext>;
    if (typeof v.businessId !== 'string' || v.businessId === '') return null;
    const str = (x: unknown) => (typeof x === 'string' ? x : null);
    return {
      businessId: v.businessId,
      businessName: str(v.businessName),
      branchId: str(v.branchId),
      branchName: str(v.branchName),
      deviceLabel: str(v.deviceLabel),
    };
  } catch {
    return null;
  }
}

export async function setCashierSelectionTicket(ticket: string): Promise<void> {
  (await cookies()).set(CASHIER_SELECT_COOKIE, ticket, options(SELECT_MAX_AGE));
}
export async function getCashierSelectionTicket(): Promise<string | undefined> {
  return (await cookies()).get(CASHIER_SELECT_COOKIE)?.value;
}
