import type { NormalizedProfileContent } from './profile-content';

/**
 * BDPN-01B part 1: the content digest that binds an approval to exactly what the moderator saw (threat T-04).
 * Frozen by `BDPN_01B_VALIDATION_AND_MODERATION_DESIGN.md` section 4.1; any change to this function changes every
 * stored digest, so the two published test vectors guard it.
 *
 *  1. Content object `{ website_url, translations[], locations[] }`.
 *  2. Every string is converted to Unicode NFC.
 *  3. `translations` are sorted by `locale` ascending and `locations` by `position` ascending.
 *  4. JSON with object keys sorted lexicographically at every level, no whitespace, absent optional values as `null`,
 *     non-ASCII characters written as themselves, encoded as UTF-8.
 *  5. The digest is the lowercase hexadecimal SHA-256 of those bytes.
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

/** The exact bytes (as text) that are hashed. */
export function canonicalProfileJson(content: NormalizedProfileContent): string {
  const translations = [...content.translations]
    .sort((a, b) => (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0))
    .map((t) => ({ locale: t.locale, display_name: t.displayName, summary: t.summary, description: t.description }));
  const locations = [...content.locations]
    .sort((a, b) => a.position - b.position)
    .map((l) => ({
      position: l.position,
      kind: l.kind,
      label: l.label,
      country_code: l.countryCode,
      city: l.city,
      region: l.region,
      street_address: l.streetAddress,
    }));
  return canonicalize({ website_url: content.websiteUrl, translations, locations });
}

export async function computeProfileDigest(content: NormalizedProfileContent): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalProfileJson(content));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
