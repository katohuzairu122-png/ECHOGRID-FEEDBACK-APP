import { ApiError } from './api-error';

/**
 * ONBOARDING-UX-01: which message a failed business or branch creation deserves. Pure, so it is unit-tested and shared by
 * both server actions; the text itself lives in the i18n files. Anything unexpected is "generic", which promises nothing
 * was saved only when that is true (the server creates a record only when it answers success).
 */
export type OnboardingErrorKey = 'slugTaken' | 'slugUnavailable' | 'invalidInput' | 'tooManyRequests' | 'forbidden' | 'generic';

export function onboardingErrorKey(error: unknown): OnboardingErrorKey {
  if (!(error instanceof ApiError)) return 'generic';
  if (error.code === 'SLUG_TAKEN') return 'slugTaken';
  if (error.code === 'SLUG_UNAVAILABLE') return 'slugUnavailable';
  if (error.status === 429) return 'tooManyRequests';
  if (error.status === 403) return 'forbidden';
  if (error.status === 400 || error.status === 422) return 'invalidInput';
  return 'generic';
}
