import { describe, expect, it } from 'vitest';
import { ApiError } from './api-error';
import { onboardingErrorKey } from './onboarding-errors';

describe('onboardingErrorKey', () => {
  it.each([
    [new ApiError('x', 409, 'SLUG_TAKEN'), 'slugTaken'],
    [new ApiError('x', 409, 'SLUG_UNAVAILABLE'), 'slugUnavailable'],
    [new ApiError('x', 429, 'RATE_LIMITED'), 'tooManyRequests'],
    [new ApiError('x', 403, 'FORBIDDEN'), 'forbidden'],
    [new ApiError('x', 400, 'VALIDATION_ERROR'), 'invalidInput'],
    [new ApiError('x', 422, 'INVALID_BUSINESS_CATEGORY'), 'invalidInput'],
    [new ApiError('x', 500, 'INTERNAL_ERROR'), 'generic'],
    [new ApiError('x', 503), 'generic'],
    [new Error('network down'), 'generic'],
    ['not an error', 'generic'],
  ])('maps %j to %s', (error, expected) => {
    expect(onboardingErrorKey(error)).toBe(expected);
  });
});
