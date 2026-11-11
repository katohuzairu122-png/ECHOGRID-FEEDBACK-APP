import { describe, expect, it } from 'vitest';
import { ApiError } from './api-error';
import { classifyReadFailure } from './read-failure';

describe('classifyReadFailure', () => {
  it.each([
    [401, 'login'],
    [403, 'forbidden'],
    [404, 'unavailable'],
    [500, 'unavailable'],
    [429, 'unavailable'],
  ])('maps status %i to %s', (status, expected) => {
    expect(classifyReadFailure(new ApiError('x', status))).toBe(expected);
  });
  it('treats a non-API error as unavailable', () => {
    expect(classifyReadFailure(new Error('network'))).toBe('unavailable');
    expect(classifyReadFailure(undefined)).toBe('unavailable');
  });
});
