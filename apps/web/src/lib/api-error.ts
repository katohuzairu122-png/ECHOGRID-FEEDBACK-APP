/**
 * The API error type, in its own module with no `server-only` dependency so
 * Client Components can `instanceof ApiError` a rejected Server Action without
 * pulling in api-client.ts's server-only session code (which breaks the RSC
 * client build). api-client.ts re-exports this, so existing server-side
 * imports of `ApiError` from '@/lib/api-client' keep working unchanged.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
