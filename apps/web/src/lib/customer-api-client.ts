import 'server-only';
import { API_BASE_URL, ApiError, parseEnvelope } from './api-client';
import { getCustomerToken } from './customer-session';

/**
 * The customer counterpart to apiFetch() -- attaches the customer JWT
 * (never the staff access token) and calls /loyalty/me/* routes. No 401-
 * refresh flow: a customer session is a single non-rotating 90-day token,
 * so there's nothing to refresh -- a 401 here means the token is missing,
 * expired, or invalid, full stop, and the caller (a Server Component/Action)
 * should redirect to /loyalty/login. Reuses parseEnvelope/ApiError from
 * api-client.ts to avoid a third copy of that envelope-parsing logic.
 */
export async function customerApiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getCustomerToken();
  if (!token) {
    throw new ApiError('Not signed in.', 401, 'UNAUTHENTICATED');
  }

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const response = await fetch(`${API_BASE_URL}/api/v1${path}`, { ...init, headers });
  return parseEnvelope<T>(response);
}
