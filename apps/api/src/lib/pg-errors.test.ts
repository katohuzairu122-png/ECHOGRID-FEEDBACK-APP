import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './pg-errors';

const pgError = (code: string, constraint?: string) =>
  Object.assign(new Error('db failure'), { code, ...(constraint ? { constraint } : {}) });

describe('isUniqueViolation', () => {
  it('matches a bare driver error', () => {
    expect(isUniqueViolation(pgError('23505', 'some_key'))).toBe(true);
  });

  it('matches a driver error wrapped in a cause, as Drizzle throws it', () => {
    const wrapped = new Error('Failed query', { cause: pgError('23505', 'some_key') });
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it('accepts postgres.js constraint_name as well as pg constraint', () => {
    const error = Object.assign(new Error('db failure'), {
      code: '23505',
      constraint_name: 'some_key',
    });
    expect(isUniqueViolation(error, ['some_key'])).toBe(true);
  });

  it('only matches the listed constraints when a list is given', () => {
    const error = pgError('23505', 'other_key');
    expect(isUniqueViolation(error, ['some_key'])).toBe(false);
    expect(isUniqueViolation(error, ['other_key', 'some_key'])).toBe(true);
  });

  it('does not match other SQLSTATE codes', () => {
    expect(isUniqueViolation(pgError('23503', 'some_key'))).toBe(false);
    expect(isUniqueViolation(pgError('40001'))).toBe(false);
  });

  it('never infers a unique violation from message text', () => {
    expect(
      isUniqueViolation(new Error('duplicate key value violates unique constraint "some_key"')),
    ).toBe(false);
  });

  it('ignores values that are not error-like', () => {
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });

  it('stops following causes after five levels', () => {
    let error: unknown = pgError('23505', 'some_key');
    for (let i = 0; i < 5; i++) error = new Error('wrapper', { cause: error });
    expect(isUniqueViolation(error)).toBe(false);
  });
});
