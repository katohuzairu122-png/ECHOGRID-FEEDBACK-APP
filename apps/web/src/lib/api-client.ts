import 'server-only';
import { getAccessToken, getRefreshToken, setSession, clearSession } from './session';
import { ApiError } from './api-error';

// Re-exported so the many server-side callers that `import { ApiError } from
// '@/lib/api-client'` keep working; the class itself now lives in the
// server-only-free api-error.ts so Client Components can import it too.
export { ApiError };

export const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:8787';

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

/**
 * The one place authenticated server-side code calls the Hono API from
 * (login/signup/logout call the API directly instead -- see
 * lib/actions/auth.ts -- since they don't have a token yet). Attaches the
 * access-token cookie as a Bearer token and, on a 401 while a token was
 * present, transparently refreshes once and retries -- callers never see a
 * spurious failure just because 15 minutes passed. If the refresh itself
 * fails (refresh token also invalid/expired), clears the session and lets
 * the original 401 surface as an ApiError; callers (Server Components,
 * Server Actions) are responsible for redirecting to /login on a 401 they
 * can't recover from.
 */
export async function apiFetch<T>(
  path: string,
  options: RequestInit & { businessId?: string; branchId?: string } = {},
): Promise<T> {
  const { businessId, branchId, ...init } = options;
  const accessToken = await getAccessToken();

  const response = await callApi(path, init, accessToken, businessId, branchId);

  if (response.status !== 401 || !accessToken) {
    return parseEnvelope<T>(response);
  }

  const refreshed = await refreshSession();
  if (!refreshed) {
    await clearSession();
    return parseEnvelope<T>(response); // surfaces the original 401
  }

  const retried = await callApi(path, init, refreshed.accessToken, businessId, branchId);
  return parseEnvelope<T>(retried);
}

async function callApi(
  path: string,
  init: RequestInit,
  accessToken: string | undefined,
  businessId?: string,
  branchId?: string,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (businessId) headers.set('X-Business-Id', businessId);
  if (branchId) headers.set('X-Branch-Id', branchId);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  return fetch(`${API_BASE_URL}/api/v1${path}`, { ...init, headers });
}

async function refreshSession(): Promise<{ accessToken: string } | null> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return null;

  const response = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!response.ok) return null;

  const body = (await response.json()) as ApiEnvelope<{ accessToken: string; refreshToken: string }>;
  if (!body.data) return null;

  await setSession(body.data);
  return { accessToken: body.data.accessToken };
}

/**
 * Exported (not just used internally by apiFetch) so lib/public-api-client.ts
 * can reuse the exact same {success,data}/{success,error} envelope handling
 * for the platform's anonymous QR/feedback routes, instead of a second
 * near-duplicate copy of this parsing logic.
 */
export async function parseEnvelope<T>(response: Response): Promise<T> {
  // DELETE /branches/:id (and any future no-content route) returns a bare
  // 204 -- no JSON body to parse into the {success,data} envelope at all,
  // so it needs its own success path rather than falling into the
  // body?.success check below (which would misread "no body" as failure).
  if (response.status === 204) {
    return undefined as T;
  }

  const body = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!response.ok || !body?.success) {
    throw new ApiError(
      body?.error?.message ?? 'Request failed.',
      response.status,
      body?.error?.code,
    );
  }
  return body.data as T;
}
