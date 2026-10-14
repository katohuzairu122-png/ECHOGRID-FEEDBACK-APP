import 'server-only';
import { notFound } from 'next/navigation';
import type { ResolveBusinessQrActionsResultDto } from '@echo-grid-feedback/shared-types';
import { API_BASE_URL, ApiError, parseEnvelope } from './api-client';
import { getCustomerToken } from './customer-session';

/** Optional authentication only for read-only public QR menus. A stale
 * customer session must not remove anonymous feedback. Protected customer
 * pages and all writes continue to use customerApiFetch and its redirects. */
export async function resolveOptionalQrActions(
  businessQrToken: string,
): Promise<ResolveBusinessQrActionsResultDto | null> {
  const token = await getCustomerToken();
  if (!token) return null;
  try {
    const response = await fetch(API_BASE_URL + '/api/v1/loyalty/me/actions/resolve-business', {
      method: 'POST',
      cache: 'no-store',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessQrToken }),
    });
    return await parseEnvelope<ResolveBusinessQrActionsResultDto>(response);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return null;
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}
