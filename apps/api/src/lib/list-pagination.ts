import { AppError } from './errors';

export interface ListPagination {
  limit?: number;
  offset?: number;
}

/**
 * DEV-65 — A shared fail-closed parser for existing staff list endpoints.
 * Absence preserves each repository's existing default. Explicit values
 * must be canonical decimal safe integers, never NaN, Infinity, fractions,
 * signed values, scientific notation, whitespace or duplicate parameters.
 *
 * Limits are endpoint-specific: messaging uses its existing 1000-row default
 * ceiling and notification sends already cap at 200.
 */
export function parseListPagination(
  params: URLSearchParams,
  maxLimit: number,
): ListPagination {
  if (!Number.isSafeInteger(maxLimit) || maxLimit < 1) {
    throw new Error('INVALID_PAGINATION_CONFIG');
  }

  const parse = (name: 'limit' | 'offset', max: number, min: number): number | undefined => {
    const values = params.getAll(name);
    if (values.length === 0) return undefined;
    const raw = values[0];
    if (
      values.length !== 1 ||
      raw === undefined ||
      !/^(?:0|[1-9][0-9]*)$/.test(raw)
    ) {
      throw new AppError('Invalid pagination query.', 400, 'INVALID_PAGINATION');
    }
    const number = Number(raw);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
      throw new AppError('Invalid pagination query.', 400, 'INVALID_PAGINATION');
    }
    return number;
  };

  const limit = parse('limit', maxLimit, 1);
  // Avoid arbitrarily large DB OFFSET scans and PostgreSQL integer overflow.
  const offset = parse('offset', 1_000_000, 0);
  return { limit, offset };
}
