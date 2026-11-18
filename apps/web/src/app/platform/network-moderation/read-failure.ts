import { ApiError } from '@/lib/api-error';

/** Access, missing-resource and invalid-input errors retain their existing recovery paths. */
export function isTemporaryReadFailure(error: unknown): boolean {
  return !(error instanceof ApiError) || (error.status >= 500 && error.status <= 599);
}
