import 'server-only';
import { API_BASE_URL } from './api-client';
import { signedAttributionHeadersSafe } from './cashier/client-attribution';

/**
 * Server-to-server call to the customer email-auth and session-lifecycle API. These routes return plain JSON
 * (`{accepted:true}`, `{error}`, the session credentials), NOT the app's `{success,data}` envelope, so the envelope parsers
 * do not apply. Every request carries the Web Worker's signed attribution: without it the API refuses to serve the route, so
 * a browser can never call it directly. Nothing returned here may reach the browser except a status code.
 */
export async function callCustomerAuthApi(
  path: string,
  init: { body?: unknown; bearer?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const headers = new Headers({ Accept: 'application/json' });
  for (const [name, value] of Object.entries(await signedAttributionHeadersSafe())) headers.set(name, value);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (init.bearer) headers.set('Authorization', `Bearer ${init.bearer}`);
  const response = await fetch(`${API_BASE_URL}/api/v1${path}`, {
    method: 'POST',
    headers,
    body: init.body === undefined ? null : JSON.stringify(init.body),
    // 'manual', never 'error': the Workers runtime does not implement redirect:'error' and throws a TypeError before any request
    // is sent (every call then looked "unavailable"). 'manual' still refuses to follow a redirect, so the bearer credential
    // cannot be forwarded elsewhere; the 3xx is returned as a status, which the callers treat as a failure.
    redirect: 'manual',
    cache: 'no-store',
  });
  if (response.status >= 300 && response.status < 400) return { status: response.status, body: null };
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

/** The web's own switch for showing email sign-up and sign-in. Off unless exactly "true"; the API has its own gate. */
export function isCustomerEmailAuthWebEnabled(): boolean {
  return process.env.CUSTOMER_EMAIL_AUTH_ENABLED === 'true';
}
