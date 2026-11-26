import type { CurrentUserDto } from '@echo-grid-feedback/shared-types';

export const shufflePath = '/platform/shuffle';

/** Platform administrators only, never while impersonating (same rule as the other platform consoles). */
export function canViewTentaship(user: Pick<CurrentUserDto, 'platformRole' | 'impersonatedBy'> | null) {
  return user?.platformRole === 'admin' && user.impersonatedBy === null;
}

export interface CampaignVersionRow { version: number; minParticipants: number; maxCapacity: number; termsVersion: string; releaseState: string; entryAcceptanceDeadline: string }
export interface CampaignRow { id: string; key: string; mode: 'guaranteed' | 'limited'; status: 'draft' | 'suspended' | 'cancelled'; statusReason: string | null; versions: CampaignVersionRow[] }
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Accepts only the documented shape; anything else is `null` (shown as "could not be loaded", never as an empty success). */
export function parseCampaigns(raw: unknown): CampaignRow[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CampaignRow[] = [];
  for (const c of raw) {
    if (!isRecord(c) || typeof c.id !== 'string' || typeof c.key !== 'string' || !['guaranteed', 'limited'].includes(String(c.mode)) || !['draft', 'suspended', 'cancelled'].includes(String(c.status)) || !Array.isArray(c.versions)) return null;
    const versions: CampaignVersionRow[] = [];
    for (const v of c.versions) {
      if (!isRecord(v) || typeof v.version !== 'number' || typeof v.minParticipants !== 'number' || typeof v.maxCapacity !== 'number' || typeof v.termsVersion !== 'string' || typeof v.releaseState !== 'string' || typeof v.entryAcceptanceDeadline !== 'string') return null;
      versions.push({ version: v.version, minParticipants: v.minParticipants, maxCapacity: v.maxCapacity, termsVersion: v.termsVersion, releaseState: v.releaseState, entryAcceptanceDeadline: v.entryAcceptanceDeadline });
    }
    out.push({ id: c.id, key: c.key, mode: c.mode as CampaignRow['mode'], status: c.status as CampaignRow['status'], statusReason: typeof c.statusReason === 'string' ? c.statusReason : null, versions });
  }
  return out;
}
