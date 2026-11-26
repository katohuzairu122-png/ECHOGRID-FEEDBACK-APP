/**
 * TSH-03: the Tentaship Shuffle control. Its OWN switch, independent of Tentaship Badges, Tentaship Drops and every Community control. Server-side only.
 * Disabled by default and FAIL-CLOSED: ONLY the exact string "true" enables it; absent, "false", "TRUE", "1", whitespace and anything else keep every
 * Shuffle route a generic 404. The control alone never replaces authorization, eligibility or the legal-release requirements: no campaign version can
 * be released at all in this block (release_state is fixed at not_released). Not declared in wrangler.toml.
 */
export const TENTASHIP_SHUFFLE_CONTROL_KEY = 'TENTASHIP_SHUFFLE_ENABLED';
export function isTentashipShuffleEnabled(env: { TENTASHIP_SHUFFLE_ENABLED?: string | undefined }): boolean {
  return env.TENTASHIP_SHUFFLE_ENABLED === 'true';
}
