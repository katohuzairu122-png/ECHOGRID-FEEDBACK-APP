import { ApiError } from './api-error';

export type StaffQrErrorKind =
  | 'session'
  | 'permission'
  | 'branch'
  | 'invalidQr'
  | 'rateLimited'
  | 'unavailable'
  | 'memberNotFound'
  | 'lookupExpired'
  | 'lookupThrottled'
  | 'lookupCap'
  | 'phoneCountryCode'
  | 'unrecognizedInput'
  | 'other';

/** Maps an API failure to a kind. Messages and tokens are never inspected or logged. */
export function classifyQrFailure(err: unknown): StaffQrErrorKind {
  if (!(err instanceof ApiError)) return 'unavailable';
  if (err.status === 401) return 'session';
  // Phone lookup (D-C2): codes are checked before the generic 429 so each gets its own message.
  if (err.code === 'LOOKUP_THROTTLED') return 'lookupThrottled';
  if (err.code === 'LOOKUP_PURCHASE_CAP_REACHED') return 'lookupCap';
  if (err.code === 'MEMBER_NOT_FOUND') return 'memberNotFound';
  if (err.code === 'LOOKUP_EXPIRED') return 'lookupExpired';
  if (err.status === 429) return 'rateLimited';
  if (err.code === 'CUSTOMER_QR_NOT_FOUND') return 'invalidQr';
  if (err.code === 'BRANCH_ACCESS_DENIED' || err.code === 'NOT_A_MEMBER') return 'branch';
  if (err.status === 403 && err.code === 'PERMISSION_DENIED') return 'permission';
  if (err.status >= 500) return 'unavailable';
  return 'other';
}
