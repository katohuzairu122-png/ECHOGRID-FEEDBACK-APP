import 'server-only';
import { API_BASE_URL, parseEnvelope } from './api-client';

/**
 * The anonymous counterpart to apiFetch() (lib/api-client.ts) -- no cookies,
 * no Authorization header, no 401-refresh flow. None of that applies to the
 * platform's one public write surface (QR Engagement's /qr/:token routes),
 * so this is a deliberately separate, smaller function rather than an
 * "anonymous mode" flag bolted onto apiFetch -- reusing session-aware
 * machinery for a route that can never have a session would misdescribe
 * what the code does, even though it would mostly work by omission.
 *
 * Envelope parsing (parseEnvelope, ApiError) is still shared with apiFetch
 * to avoid a second copy of that logic.
 */
export async function publicApiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const response = await fetch(`${API_BASE_URL}/api/v1${path}`, { ...init, headers });
  return parseEnvelope<T>(response);
}
