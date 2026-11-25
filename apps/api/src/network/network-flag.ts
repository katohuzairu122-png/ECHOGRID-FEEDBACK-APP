/**
 * The Network Feed feature flag (NETWORK-00 section 6, NT-17). Disabled by default in every environment; ONLY the exact
 * string "true" enables it. Every /network route and every platform moderation route answers a generic 404 when it is
 * off, and the customer Community hides the Feed section.
 */
export function isNetworkFeedEnabled(env: { NETWORK_FEED_ENABLED?: string | undefined }): boolean {
  return env.NETWORK_FEED_ENABLED === 'true';
}

/**
 * BCOMM-03: business publishing is its OWN control, independent of the Feed flag and of every Community enrollment control. Only the exact
 * string "true" opens it; absent, "TRUE", "1" or anything else is closed (fail closed). It gates business post authoring and submission
 * (create, edit, submit, withdraw). Reading a business's OWN historical posts is never gated, so closing it never hides or destroys history.
 */
export function isBusinessPublishingEnabled(env: { NETWORK_BUSINESS_PUBLISHING_ENABLED?: string | undefined }): boolean {
  return env.NETWORK_BUSINESS_PUBLISHING_ENABLED === 'true';
}

/**
 * BCOMM-04: whether APPROVED business posts are shown to customers in the Community Feed and discovery surfaces. Independent of publishing
 * and of the Feed flag (the Feed itself still needs NETWORK_FEED_ENABLED); exact "true" only. Closing it removes business posts from
 * customer reads at once while every post, revision and audit record stays.
 */
export function isBusinessDistributionEnabled(env: { NETWORK_BUSINESS_DISTRIBUTION_ENABLED?: string | undefined }): boolean {
  return env.NETWORK_BUSINESS_DISTRIBUTION_ENABLED === 'true';
}
