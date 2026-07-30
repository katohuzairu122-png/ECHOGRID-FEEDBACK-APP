import type { Context } from 'hono';

/**
 * Standard success envelope: { success: true, data }. Every route returns
 * through this, or throws an AppError (wrapped by lib/error-handler.ts into
 * { success: false, error }), so every API response uses the same shape.
 */
export function ok<T>(c: Context, data: T, status: 200 | 201 | 202 = 200) {
  return c.json({ success: true, data }, status);
}
