import { ApiError } from './api-error';

export type ReadFailure = 'login' | 'forbidden' | 'unavailable';

/** Classifies a failed read: 401 goes to login, 403 is a denial (no retry), anything else is an outage. */
export function classifyReadFailure(error: unknown): ReadFailure {
  if (!(error instanceof ApiError)) return 'unavailable';
  if (error.status === 401) return 'login';
  if (error.status === 403) return 'forbidden';
  return 'unavailable';
}
