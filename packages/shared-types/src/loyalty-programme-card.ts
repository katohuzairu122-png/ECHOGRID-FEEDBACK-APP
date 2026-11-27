import { formatMoney, parseMoney } from './loyalty-money';
import { milestoneStateFrom, missionStateFrom, streakStateFrom } from './loyalty-engines';
import { stampStateFrom, type LoyaltyProgramType } from './loyalty-programs';

/**
 * LPC-07: the CUSTOMER's own view of the business's active programme. Pure and locale-neutral: the screen supplies the words. The view carries
 * only the customer's own progress and the programme's public terms (thresholds, windows, reward ids); never another customer's data, an
 * internal id other than the reward ids the customer can already see in the catalogue, or a cashier/owner field.
 */
export type ProgrammeCardView =
  | { kind: 'points'; type: 'LP-02' | 'LP-03' }
  | { kind: 'offpeak'; windows: { days: number[]; start: string; end: string; multiplier?: string; bonusPoints?: number }[]; effectiveFrom: string | null; effectiveUntil: string | null }
  | { kind: 'stamps'; stamps: number; threshold: number; rewardId: string; completedCards: number; expiresAt: string | null; expired: boolean; fraction: number }
  | { kind: 'milestones'; metric: 'purchases' | 'spend' | 'visits'; current: string; ladder: { threshold: string; rewardId: string; achieved: boolean }[]; fraction: number }
  | { kind: 'streak'; period: 'day' | 'week'; streak: number; required: number; gracePeriods: number; rewardId: string; completedStreaks: number; fraction: number }
  | { kind: 'missions'; missions: { key: string; objective: 'purchases' | 'spend' | 'visits'; target: string; current: string; status: 'not_started' | 'active' | 'completed' | 'expired'; endsAt: string | null; rewardId: string; fraction: number }[] };

const DAY_MS = 86_400_000;
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Builds the view for one programme and one customer's persisted counters. `now` is the server clock; `currency` is the business currency. */
export function programmeCardView(
  type: LoyaltyProgramType,
  config: Record<string, unknown>,
  counters: Record<string, unknown> | null | undefined,
  currency: string,
  now: Date,
): ProgrammeCardView | null {
  switch (type) {
    case 'LP-02':
    case 'LP-03':
      return { kind: 'points', type };
    case 'LP-06': {
      const windows = (config.windows as { days: number[]; start: string; end: string; multiplier?: string; bonusPoints?: number }[] | undefined) ?? [];
      return { kind: 'offpeak', windows, effectiveFrom: (config.effectiveFrom as string | undefined) ?? null, effectiveUntil: (config.effectiveUntil as string | undefined) ?? null };
    }
    case 'LP-01': {
      const threshold = Number(config.stampThreshold);
      const state = stampStateFrom(counters);
      const expiryDays = typeof config.stampExpiryDays === 'number' ? config.stampExpiryDays : null;
      const expiresAtMs = state.cycleStartedAt && expiryDays !== null && state.stamps > 0 ? Date.parse(state.cycleStartedAt) + expiryDays * DAY_MS : null;
      const expired = expiresAtMs !== null && expiresAtMs <= now.getTime();
      const stamps = expired ? 0 : state.stamps;
      return {
        kind: 'stamps', stamps, threshold, rewardId: String(config.rewardId), completedCards: state.cycle,
        expiresAt: expiresAtMs !== null && !expired ? new Date(expiresAtMs).toISOString() : null, expired, fraction: clamp01(stamps / threshold),
      };
    }
    case 'LP-04': {
      const metric = config.metric as 'purchases' | 'spend' | 'visits';
      const state = milestoneStateFrom(counters);
      const ladder = (config.milestones as { threshold: string; rewardId: string }[]).map((m) => ({ threshold: m.threshold, rewardId: m.rewardId, achieved: state.achieved.includes(m.rewardId) || state.achieved.includes(m.threshold) }));
      const currentValue = metric === 'spend' ? state.spendMinor : state.count;
      const thresholds = ladder.map((m) => (metric === 'spend' ? Number(parseMoney(m.threshold, currency)) : Number(m.threshold)));
      const nextIdx = thresholds.findIndex((t) => t > currentValue);
      const next = nextIdx === -1 ? null : thresholds[nextIdx]!;
      const prev = nextIdx > 0 ? thresholds[nextIdx - 1]! : 0;
      return {
        kind: 'milestones', metric, ladder,
        current: metric === 'spend' ? formatMoney(BigInt(state.spendMinor), currency) : String(state.count),
        fraction: next === null ? 1 : clamp01((currentValue - prev) / (next - prev)),
      };
    }
    case 'LP-05': {
      const state = streakStateFrom(counters);
      const required = Number(config.requiredPeriods);
      return {
        kind: 'streak', period: config.period as 'day' | 'week', streak: state.streak, required, gracePeriods: Number(config.gracePeriods),
        rewardId: String(config.rewardId), completedStreaks: state.cycle, fraction: clamp01(state.streak / required),
      };
    }
    case 'LP-07': {
      const state = missionStateFrom(counters);
      const missions = (config.missions as { key: string; objective: 'purchases' | 'spend' | 'visits'; target: string; windowDays: number; rewardId: string }[]).map((m) => {
        const progress = state.missions[m.key];
        const endsAtMs = progress ? Date.parse(progress.startedAt) + m.windowDays * DAY_MS : null;
        const expired = progress?.status === 'active' && endsAtMs !== null && endsAtMs <= now.getTime();
        const status: 'not_started' | 'active' | 'completed' | 'expired' = !progress || expired ? (expired ? 'expired' : 'not_started') : progress.status;
        const live = status === 'active' || status === 'completed';
        const value = live ? (m.objective === 'spend' ? progress!.spendMinor : progress!.count) : 0;
        const target = m.objective === 'spend' ? Number(parseMoney(m.target, currency)) : Number(m.target);
        return {
          key: m.key, objective: m.objective, target: m.target, status, rewardId: m.rewardId,
          current: m.objective === 'spend' ? formatMoney(BigInt(value), currency) : String(value),
          endsAt: status === 'active' && endsAtMs !== null ? new Date(endsAtMs).toISOString() : null,
          fraction: status === 'completed' ? 1 : clamp01(value / target),
        };
      });
      return { kind: 'missions', missions };
    }
    default:
      return null;
  }
}

/** The JSON a customer's browser receives (dates as ISO strings). */
export interface CustomerProgrammeCardDto {
  /** The business currency, for formatting spend thresholds. */
  currency: string;
  programme: { type: string; view: ProgrammeCardView; rewardNames: Record<string, string> } | null;
  earnedRewards: { rewardName: string; expiresAt: string | null }[];
}
