/**
 * TDP-02: the Tentaship Drops control. Its OWN switch, independent of Tentaship Badges, Tentaship Shuffle and every Community control. Server-side only.
 * Disabled by default and FAIL-CLOSED: ONLY the exact string "true" enables it; absent, "false", "TRUE", "1", whitespace and anything else keep every
 * Drops route a generic 404. The control alone never replaces authorization or the legal approval of sponsorship terms. Not declared in wrangler.toml.
 */
export const TENTASHIP_DROPS_CONTROL_KEY = 'TENTASHIP_DROPS_ENABLED';
export function isTentashipDropsEnabled(env: { TENTASHIP_DROPS_ENABLED?: string | undefined }): boolean {
  return env.TENTASHIP_DROPS_ENABLED === 'true';
}
