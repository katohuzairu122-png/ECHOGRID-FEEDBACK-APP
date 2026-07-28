/** Mirrors the existing API_BASE_URL pattern (api-client.ts) -- resolved
 * server-side only, so no NEXT_PUBLIC_ prefix needed. Used by
 * metadataBase/robots.ts/sitemap.ts for absolute URLs. */
export const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
