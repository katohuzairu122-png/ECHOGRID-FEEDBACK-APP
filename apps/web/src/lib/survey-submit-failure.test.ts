import { describe, expect, it } from 'vitest';
import { ApiError } from './api-error';
import { classifySurveySubmitError } from './survey-submit-failure';

describe('classifySurveySubmitError', () => {
  it.each([
    [403, 'forbidden'],
    [404, 'closed'],
    [409, 'closed'],
    [400, 'invalid'],
    [422, 'invalid'],
    [500, 'unavailable'],
    [429, 'unavailable'],
  ])('maps status %i to %s', (status, expected) => {
    expect(classifySurveySubmitError(new ApiError('x', status))).toBe(expected);
  });
  it('treats a non-API error as unavailable', () => {
    expect(classifySurveySubmitError(new Error('network'))).toBe('unavailable');
  });
});
