import { ApiError } from './api-error';
import type { SurveySubmitFailure } from './surveys-types';

/** Maps a failed start/submit call to a localizable failure kind (the API's own messages are English only). */
export function classifySurveySubmitError(error: unknown): SurveySubmitFailure {
  if (!(error instanceof ApiError)) return 'unavailable';
  if (error.status === 403) return 'forbidden';
  if (error.status === 404 || error.status === 409) return 'closed';
  if (error.status === 400 || error.status === 422) return 'invalid';
  return 'unavailable';
}
