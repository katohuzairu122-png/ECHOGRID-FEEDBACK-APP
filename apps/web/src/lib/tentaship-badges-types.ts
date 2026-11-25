/** TB-03 DTO. A badge is an achievement: no balance, value or transfer fields exist. */
export interface EarnedBadgeDto {
  awardId: string; definitionKey: string; version: number;
  names: Record<string, string>; descriptions: Record<string, string>; awardedAt: string;
}
export type BadgesResult = { state: 'ready'; badges: EarnedBadgeDto[] } | { state: 'closed' } | { state: 'unavailable' };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isTextMap = (v: unknown): v is Record<string, string> => isRecord(v) && Object.values(v).every((x) => typeof x === 'string');

/** Accepts only the documented shape; anything else is `unavailable` (never an invented or empty-looking success). */
export function parseBadges(raw: unknown): BadgesResult {
  if (!isRecord(raw) || !Array.isArray(raw.badges)) return { state: 'unavailable' };
  const badges: EarnedBadgeDto[] = [];
  for (const b of raw.badges) {
    if (!isRecord(b) || typeof b.awardId !== 'string' || typeof b.definitionKey !== 'string' || typeof b.version !== 'number' || typeof b.awardedAt !== 'string'
      || !isTextMap(b.names) || !isTextMap(b.descriptions)) return { state: 'unavailable' };
    badges.push({ awardId: b.awardId, definitionKey: b.definitionKey, version: b.version, names: b.names, descriptions: b.descriptions, awardedAt: b.awardedAt });
  }
  return { state: 'ready', badges };
}

/** Name in the viewer's language, falling back to English (the only required language). */
export const badgeText = (map: Record<string, string>, locale: string): string => map[locale] ?? map.en ?? '';
