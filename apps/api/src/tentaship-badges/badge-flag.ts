/**
 * TB-02: the Tentaship Badges control. Its OWN switch, independent of every Community control (NETWORK_FEED_ENABLED, publishing, distribution,
 * membership and pilot controls) and of any future Tentaship Shuffle or Drops control. Server-side only; never client-supplied.
 *
 * Disabled by default in every environment and FAIL-CLOSED: ONLY the exact string "true" enables it. Absent, "false", "TRUE", "1", " true",
 * "true " and every other value leave every badge route answering a generic 404 and prevent any award from being computed or written.
 * Not declared in wrangler.toml: it is set per environment only at an Owner-authorised activation.
 */
export const TENTASHIP_BADGES_CONTROL_KEY = 'TENTASHIP_BADGES_ENABLED';

export function isTentashipBadgesEnabled(env: { TENTASHIP_BADGES_ENABLED?: string | undefined }): boolean {
  return env.TENTASHIP_BADGES_ENABLED === 'true';
}
