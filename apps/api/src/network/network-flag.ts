/**
 * The Network Feed feature flag (NETWORK-00 section 6, NT-17). Disabled by default in every environment; ONLY the exact
 * string "true" enables it. Every /network route and every platform moderation route answers a generic 404 when it is
 * off, and the customer Community hides the Feed section.
 */
export function isNetworkFeedEnabled(env: { NETWORK_FEED_ENABLED?: string | undefined }): boolean {
  return env.NETWORK_FEED_ENABLED === 'true';
}
