import type { ErrorHandler } from 'hono';
import type { Bindings } from '../config/env';
import { AppError } from './errors';

/**
 * Global error handler, registered via app.onError() in index.ts. AppError
 * instances (AuthError, and anything future feature modules throw) map
 * straight to their declared status/code/details. Anything else is an
 * unexpected/programmer error: logged with full detail here, returned to
 * the client as a generic 500 with no internal message or stack trace.
 */
export const errorHandler: ErrorHandler<{ Bindings: Bindings }> = (err, c) => {
  if (err instanceof AppError) {
    return c.json(
      {
        success: false,
        error: { code: err.code, message: err.message, details: err.details },
      },
      err.status,
    );
  }

  console.error('Unhandled error:', err);
  return c.json(
    { success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } },
    500,
  );
};
