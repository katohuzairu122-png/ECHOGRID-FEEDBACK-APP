/**
 * TSH-06 DTOs for the customer-facing campaign components. Display-only: every field is a RECORDED server value; nothing here lets a client decide an
 * eligibility, an entry or an outcome. There is no odds, prize, value or price field, and no "guaranteed" wording exists (Mode B wording stays unresolved).
 */
export type CampaignStatus = 'draft' | 'suspended' | 'cancelled';
export type EligibilityState = 'met' | 'notMet' | 'notEvaluated';
export type ParticipationState = 'none' | 'invited' | 'accepted' | 'admitted' | 'declined' | 'expired' | 'withdrawn' | 'cancelled';
export interface CampaignCardDto {
  campaignId: string; status: CampaignStatus; termsVersion: string; disclosure: Record<string, string>; disclosureHash: string;
  eligibility: EligibilityState; participation: ParticipationState; outcomeRecorded: boolean;
}
export type CampaignResult = { state: 'ready'; campaign: CampaignCardDto } | { state: 'unavailable' };
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, set: readonly T[]): v is T => typeof v === 'string' && (set as readonly string[]).includes(v);

/** Only the documented shape is accepted; anything else is `unavailable`, never an invented success. */
export function parseCampaign(raw: unknown): CampaignResult {
  if (!isRecord(raw) || !isRecord(raw.disclosure) || !Object.values(raw.disclosure).every((x) => typeof x === 'string')) return { state: 'unavailable' };
  if (typeof raw.campaignId !== 'string' || typeof raw.termsVersion !== 'string' || typeof raw.disclosureHash !== 'string' || typeof raw.outcomeRecorded !== 'boolean') return { state: 'unavailable' };
  if (!oneOf(raw.status, ['draft', 'suspended', 'cancelled'] as const) || !oneOf(raw.eligibility, ['met', 'notMet', 'notEvaluated'] as const)
    || !oneOf(raw.participation, ['none', 'invited', 'accepted', 'admitted', 'declined', 'expired', 'withdrawn', 'cancelled'] as const)) return { state: 'unavailable' };
  return { state: 'ready', campaign: { campaignId: raw.campaignId, status: raw.status, termsVersion: raw.termsVersion, disclosure: raw.disclosure as Record<string, string>, disclosureHash: raw.disclosureHash, eligibility: raw.eligibility, participation: raw.participation, outcomeRecorded: raw.outcomeRecorded } };
}
/** The recorded disclosure in the viewer's language, falling back to English (the only required language). Never translated or reworded by the UI. */
export const disclosureText = (d: Record<string, string>, locale: string): string => d[locale] ?? d.en ?? '';
