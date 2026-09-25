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

type RefreshedTokens = { accessToken: string; refreshToken: string };
type RefreshResult =
  | { kind: 'refreshed'; tokens: RefreshedTokens }
  | { kind: 'rotated-elsewhere' }
  | { kind: 'failed' };

/**
 * A dashboard render can start several apiFetch calls together. When the
 * access token has just expired, every call receives 401 and reaches the
 * refresh endpoint with the same rotating refresh token. Only the first
 * rotation can succeed; without this lock, a losing call clears the valid
 * session created by the winner.
 *
 * The key is removed as soon as the request settles. Keeping this at module
 * scope lets concurrent RSC/API calls handled by the same Worker isolate
 * share the in-flight rotation without retaining session tokens afterward.
 */
const refreshRequests = new Map<string, Promise<RefreshResult>>();

/**
 * The one place authenticated server-side code calls the Hono API from
 * (login/signup/logout call the API directly instead -- see
 * lib/actions/auth.ts -- since they don't have a token yet). Attaches the
 * access-token cookie as a Bearer token and, on a 401, transparently
 * refreshes once and retries -- including when the 15-minute access cookie
 * has already disappeared while the 30-day refresh cookie remains. If the refresh itself
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

  if (response.status !== 401) {
    return parseEnvelope<T>(response);
  }

  const refreshed = await refreshSession();
  if (refreshed.kind !== 'refreshed') {
    // A concurrent request handled by another Worker isolate may have won
    // the same rotation and already written a valid cookie pair. Its losing
    // sibling must not delete those cookies. Genuinely invalid/expired
    // sessions still take the existing clear-and-login path.
    if (refreshed.kind === 'failed') await clearSession();
    return parseEnvelope<T>(response); // surfaces the original 401
  }

  const retried = await callApi(path, init, refreshed.tokens.accessToken, businessId, branchId);
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

async function refreshSession(): Promise<RefreshResult> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return { kind: 'failed' };

  let request = refreshRequests.get(refreshToken);
  if (!request) {
    request = requestRefreshedTokens(refreshToken);
    refreshRequests.set(refreshToken, request);
    void request.then(
      () => refreshRequests.delete(refreshToken),
      () => refreshRequests.delete(refreshToken),
    );
  }

  const tokens = await request;
  if (tokens.kind !== 'refreshed') return tokens;

  // Each caller writes the same rotated pair to its own response context.
  // This matters when Cloudflare coalesces work in one isolate but the calls
  // originated from separate RSC requests.
  await setSession(tokens.tokens);
  return tokens;
}

async function requestRefreshedTokens(refreshToken: string): Promise<RefreshResult> {
  const response = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  const body = (await response.json()) as ApiEnvelope<RefreshedTokens>;
  if (!response.ok) {
    return body.error?.code === 'REFRESH_TOKEN_ROTATED'
      ? { kind: 'rotated-elsewhere' }
      : { kind: 'failed' };
  }
  return body.data ? { kind: 'refreshed', tokens: body.data } : { kind: 'failed' };
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
