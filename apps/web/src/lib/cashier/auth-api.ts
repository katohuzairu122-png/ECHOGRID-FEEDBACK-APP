import 'server-only';
import { API_BASE_URL, parseEnvelope, ApiError } from '../api-client';
import {
  clearCashierSession,
  getCashierContext,
  getCashierAccessToken,
  getCashierRefreshToken,
  setCashierSession,
  type CashierSessionPayload,
} from './session';

export interface CashierChoiceDto {
  businessId: string;
  businessName: string;
  wideAccess: boolean;
  branches: { id: string; name: string }[];
}

export type CashierLoginResponse =
  | ({ status: 'authenticated' } & CashierSessionPayload)
  | { status: 'selection_required'; ticket: string; choices: CashierChoiceDto[] };

/** POST to a /auth/cashier/* endpoint. These take credentials or a cashier refresh token in the body, never a bearer. */
export async function postCashierAuth<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/api/v1/auth/cashier/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  return parseEnvelope<T>(response);
}

/** Refusals that mean this session is over for good. Anything else (network, 5xx, rate limit, a concurrent rotation) is transient. */
const DEFINITIVE_REFRESH_FAILURES = new Set(['INVALID_REFRESH_TOKEN', 'CASHIER_ACCESS_REVOKED', 'ACCOUNT_INACTIVE']);

/**
 * Rotates the cashier refresh token and stores the new pair. ONLY call this where cookies can be written (a server
 * action or a route handler): rotating without persisting the new token would strand the session and trip replay
 * protection. Returns false when it cannot refresh. The cashier cookies are cleared ONLY for a definitive refusal
 * (revoked, expired, access removed, replayed): a network blip, a 5xx or a concurrent rotation by another request
 * leaves them in place, so a flaky counter connection or two racing requests never sign a live session out.
 */
export async function refreshCashierSession(): Promise<boolean> {
  const refreshToken = await getCashierRefreshToken();
  if (!refreshToken) return false;
  try {
    const next = await postCashierAuth<CashierSessionPayload>('refresh', { refreshToken });
    await setCashierSession(next);
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.code && DEFINITIVE_REFRESH_FAILURES.has(err.code)) {
      await clearCashierSession();
    }
    return false;
  }
}

/** Server actions: make sure an access token exists, refreshing from the refresh cookie when the 15-minute one lapsed. */
export async function ensureCashierAccess(): Promise<boolean> {
  if (await getCashierAccessToken()) return true;
  return refreshCashierSession();
}

/**
 * Cashier reads for server components: the cashier token plus the context bound at sign-in. Restricted to the C2
 * allow-list by the API itself; this helper adds nothing to it. Never refreshes (render cannot write cookies).
 */
export async function cashierApiFetch<T>(path: string): Promise<T> {
  const [token, ctx] = await Promise.all([getCashierAccessToken(), getCashierContext()]);
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (ctx) {
    headers.set('X-Business-Id', ctx.businessId);
    if (ctx.branchId) headers.set('X-Branch-Id', ctx.branchId);
  }
  const response = await fetch(`${API_BASE_URL}/api/v1${path}`, { headers, cache: 'no-store' });
  return parseEnvelope<T>(response);
}
