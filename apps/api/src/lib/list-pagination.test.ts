import { describe, expect, it } from 'vitest';
import { AppError } from './errors';
import { parseListPagination } from './list-pagination';

const parse = (q: string, max = 200) => parseListPagination(new URLSearchParams(q), max);
const rejects = (q: string, max = 200) => {
  try {
    parse(q, max);
    throw new Error('Expected INVALID_PAGINATION');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(400);
    expect((error as AppError).code).toBe('INVALID_PAGINATION');
  }
};

describe('DEV-65 bounded list pagination', () => {
  it('preserves repository default behavior when parameters are absent', () => {
    expect(parse('')).toEqual({ limit: undefined, offset: undefined });
    expect(parse('someOtherFilter=x')).toEqual({ limit: undefined, offset: undefined });
  });

  it('accepts canonical integer parameters including zero offset and endpoint-specific caps', () => {
    expect(parse('limit=50&offset=0')).toEqual({ limit: 50, offset: 0 });
    expect(parse('limit=200&offset=1000000')).toEqual({ limit: 200, offset: 1_000_000 });
    expect(parse('limit=1000&offset=15', 1000)).toEqual({ limit: 1000, offset: 15 });
    expect(parse('offset=10')).toEqual({ limit: undefined, offset: 10 });
    expect(parse('limit=1')).toEqual({ limit: 1, offset: undefined });
  });

  it.each([
    'limit=', 'offset=', 'limit=0', 'limit=-1', 'offset=-1',
    'limit=1.5', 'offset=1.5', 'limit=1e2', 'offset=Infinity',
    'limit=+1', 'limit=01', 'offset=00', 'limit=%201',
    'limit=NaN', 'limit=9007199254740993',
    'limit=201', 'offset=1000001',
    'limit=10&limit=20', 'offset=0&offset=1',
  ])('rejects malformed or unbounded query %s', q => rejects(q));

  it('uses a separate ceiling for conversation lists', () => {
    expect(parse('limit=1000', 1000).limit).toBe(1000);
    rejects('limit=1001', 1000);
  });

  it('rejects invalid internal page limits without invoking a DB', () => {
    expect(() => parse('', 0)).toThrow('INVALID_PAGINATION_CONFIG');
    expect(() => parse('', Infinity)).toThrow('INVALID_PAGINATION_CONFIG');
  });
});
