import type { OnboardingSummary } from '../repositories/customer-onboarding-event.repository';

/**
 * D2-FINAL small-group privacy controls for onboarding analytics. PURE: it takes an already computed summary and a policy, and returns a
 * version in which no cell small enough to single out a customer is disclosed. The THRESHOLD IS NOT DECIDED HERE: it is a parameter, and
 * the analytics route does not apply it until the Owner approves a privacy standard (R4). With no policy the summary is returned unchanged.
 *
 * Rules (documented so a reviewer can verify them):
 *  - a cell with fewer than `minGroupSize` EVENTS is folded into one suppressed bucket per dimension;
 *  - complementary suppression: if that bucket is itself below the threshold, the smallest visible cell is folded in too, repeatedly, so the
 *    hidden counts cannot be recovered by subtracting the visible cells from the total;
 *  - if everything in a dimension ends up below the threshold, the dimension reports one suppressed bucket with no counts;
 *  - `uniqueCustomers` is shown only when it is itself at least the threshold, else null;
 *  - the total number of events is shown only when at least the threshold; small non-zero side counts (rejoins, no-branch, erased) become null;
 *  - the per-cashier breakdown can be removed entirely (`suppressCashierBreakdown`), because cashier attribution is an indirect identifier (R3).
 * Nothing is estimated, inferred or back-filled.
 */
export interface SmallGroupPolicy {
  minGroupSize: number;
  suppressCashierBreakdown?: boolean;
}

export interface PrivateBucket {
  events: number | null;
  uniqueCustomers: number | null;
}
export type PrivateCell<K extends object> = (K & PrivateBucket & { suppressed: false }) | ({ suppressed: true } & PrivateBucket);
export interface PrivateOnboardingSummary {
  policy: { minGroupSize: number; suppressCashierBreakdown: boolean };
  totals: PrivateBucket & { rejoinEvents: number | null; withoutBranch: number | null; erasedEvents: number | null };
  bySource: Array<PrivateCell<{ source: string }>>;
  byBranch: Array<PrivateCell<{ branchId: string | null; branchName: string | null }>>;
  byCashier: Array<PrivateCell<{ cashierUserId: string; displayName: string | null }>> | null;
}

const shown = (v: number, k: number): number | null => (v >= k ? v : null);
const sideCount = (v: number, k: number): number | null => (v === 0 || v >= k ? v : null);

function suppressCells<C extends { events: number; uniqueCustomers: number }, K extends object>(cells: C[], k: number, keyOf: (c: C) => K): Array<PrivateCell<K>> {
  let visible = cells.filter((c) => c.events >= k);
  let hidden = cells.filter((c) => c.events < k);
  // complementary suppression: fold the smallest visible cell in until the hidden bucket is itself safe (or nothing is left to fold)
  let hiddenEvents = hidden.reduce((s, c) => s + c.events, 0);
  while (hidden.length > 0 && hiddenEvents < k && visible.length > 0) {
    visible = [...visible].sort((a, b) => a.events - b.events);
    const [smallest, ...rest] = visible;
    visible = rest;
    hidden = [...hidden, smallest!];
    hiddenEvents += smallest!.events;
  }
  const out: Array<PrivateCell<K>> = visible.map((c) => ({ ...keyOf(c), events: c.events, uniqueCustomers: shown(c.uniqueCustomers, k), suppressed: false as const }));
  if (hidden.length > 0) out.push({ suppressed: true, events: hiddenEvents >= k ? hiddenEvents : null, uniqueCustomers: null });
  return out;
}

export function applySmallGroupSuppression(summary: OnboardingSummary, policy: SmallGroupPolicy): PrivateOnboardingSummary {
  const k = policy.minGroupSize;
  if (!Number.isInteger(k) || k < 2) throw new Error('SMALL_GROUP_THRESHOLD_INVALID');
  const suppressCashier = policy.suppressCashierBreakdown === true;
  return {
    policy: { minGroupSize: k, suppressCashierBreakdown: suppressCashier },
    totals: {
      events: shown(summary.totals.events, k),
      uniqueCustomers: shown(summary.totals.uniqueCustomers, k),
      rejoinEvents: sideCount(summary.totals.rejoinEvents, k),
      withoutBranch: sideCount(summary.totals.withoutBranch, k),
      erasedEvents: sideCount(summary.totals.erasedEvents, k),
    },
    bySource: suppressCells(summary.bySource, k, (c) => ({ source: c.source })),
    byBranch: suppressCells(summary.byBranch, k, (c) => ({ branchId: c.branchId, branchName: c.branchName })),
    byCashier: suppressCashier ? null : suppressCells(summary.byCashier, k, (c) => ({ cashierUserId: c.cashierUserId, displayName: c.displayName })),
  };
}
