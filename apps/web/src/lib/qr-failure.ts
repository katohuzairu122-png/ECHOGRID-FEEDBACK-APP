import { ApiError } from './api-error';

export type StaffQrErrorKind =
  'session' | 'permission' | 'branch' | 'invalidQr' | 'rateLimited' | 'unavailable' | 'other';

/** Maps an API failure to a kind. Messages and tokens are never inspected or logged. */
export function classifyQrFailure(err: unknown): StaffQrErrorKind {
  if (!(err instanceof ApiError)) return 'unavailable';
  if (err.status === 401) return 'session';
  if (err.status === 429) return 'rateLimited';
  if (err.code === 'CUSTOMER_QR_NOT_FOUND') return 'invalidQr';
  if (err.code === 'BRANCH_ACCESS_DENIED' || err.code === 'NOT_A_MEMBER') return 'branch';
  if (err.status === 403 && err.code === 'PERMISSION_DENIED') return 'permission';
  if (err.status >= 500) return 'unavailable';
  return 'other';
}
