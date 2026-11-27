import { earnForCheckin, earnForPurchase, parseRate, pointsFor, type PurchaseFact } from '@echo-grid-feedback/shared-types';
import type { ResolvedProgramme } from './program.service';

/** The programme (and configuration version) that produced an earning, stored on the ledger row for provenance. */
export interface EarningProvenance {
  readonly programId: string;
  readonly programVersion: number;
}

export interface ComputedEarning {
  readonly points: number;
  readonly provenance: EarningProvenance | null;
  readonly note?: string;
}

/** The pre-programme earning settings, used only by a business that has no programme row at all (it keeps earning exactly as before). */
export interface LegacySettings {
  readonly pointsPerCheckin: number;
  readonly pointsPerCurrencyUnit: string;
}

/**
 * Points for a verified purchase under the business's active programme. A business that chose Configure Later (or paused every programme)
 * earns nothing, and says so in the ledger note; it never silently falls back to some default programme.
 */
export function computePurchaseEarning(
  resolved: ResolvedProgramme,
  legacy: LegacySettings,
  fact: PurchaseFact,
): ComputedEarning {
  if (resolved.kind === 'implicit_legacy') {
    return { points: pointsFor(fact.amountMinor, fact.currency, parseRate(legacy.pointsPerCurrencyUnit)), provenance: null };
  }
  if (resolved.kind === 'none') {
    return { points: 0, provenance: null, note: 'No active loyalty programme: this purchase earned nothing.' };
  }
  const result = earnForPurchase(resolved.type, resolved.config, fact);
  return {
    points: result.points,
    provenance: { programId: resolved.programId, programVersion: resolved.version },
    ...(result.qualifying ? {} : { note: `Did not qualify (${result.reason ?? 'not eligible'}).` }),
  };
}

export function computeCheckinEarning(resolved: ResolvedProgramme, legacy: LegacySettings): ComputedEarning {
  if (resolved.kind === 'implicit_legacy') return { points: legacy.pointsPerCheckin, provenance: null };
  if (resolved.kind === 'none') return { points: 0, provenance: null, note: 'No active loyalty programme: this check-in earned no points.' };
  return {
    points: earnForCheckin(resolved.type, resolved.config),
    provenance: { programId: resolved.programId, programVersion: resolved.version },
  };
}
