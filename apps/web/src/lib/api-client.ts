import 'server-only';
import { getAccessToken } from './session';
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
 * The one place authenticated server-side code calls the Hono API from.
 * Session rotation happens in middleware.ts, where Next.js permits response
 * cookies to be written. Server Components may read cookies but must never
 * refresh or clear them during render.
 */
export async function apiFetch<T>(
  path: string,
  options: RequestInit & { businessId?: string; branchId?: string } = {},
): Promise<T> {
  const { businessId, branchId, ...init } = options;
  const accessToken = await getAccessToken();
  const response = await callApi(path, init, accessToken, businessId, branchId);
  return parseEnvelope<T>(response);
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

/**
 * Exported so lib/public-api-client.ts can reuse the same API envelope
 * handling for anonymous QR and feedback routes.
 */
export async function parseEnvelope<T>(response: Response): Promise<T> {
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
