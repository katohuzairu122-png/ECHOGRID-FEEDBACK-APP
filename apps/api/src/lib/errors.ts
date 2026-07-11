/**
 * Base class for errors that should map directly to an HTTP response via
 * the global error handler (index.ts -> app.onError, lib/error-handler.ts).
 * Anything thrown that is NOT an AppError is treated as unexpected: logged
 * with full detail server-side, returned to the client as a generic 500
 * with no internal message or stack trace leaked.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
