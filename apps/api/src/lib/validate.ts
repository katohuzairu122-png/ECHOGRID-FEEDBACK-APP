import type { z } from 'zod';
import { AppError } from './errors';

/**
 * Parses and validates a JSON request body, throwing an AppError (caught by
 * the global error handler) on failure instead of every route hand-rolling
 * its own 400 response. Takes a standard Request (c.req.raw), not a Hono
 * Context, so it stays framework-adjacent and testable on its own.
 */
export async function parseJsonBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('Invalid request body.', 400, 'VALIDATION_ERROR', parsed.error.issues);
  }
  return parsed.data;
}
