import { z } from 'zod';
import { currencyExponent, formatMoney, MoneyError, parseMoney, parseRate, type Rate } from './loyalty-money';

/**
 * LOYALTY-PROGRAMME-COMPLETION, Group 02: the progress-based and time-based programmes (LP-04 milestones, LP-05 streaks, LP-06 off-peak,
 * LP-07 missions). Pure and deterministic: no clock, no I/O. Every time-dependent rule takes the SERVER-recorded instant and the business IANA
 * timezone; nothing a cashier or customer sends can change eligibility.
 */

export interface ConfigIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}
export type EngineConfigResult =
  | { readonly ok: true; readonly config: Record<string, unknown>; readonly rewardIds: readonly string[] }
  | { readonly ok: false; readonly errors: readonly ConfigIssue[] };

/** Reward types an earned entitlement may point at: a points-cost reward is redeemed from the balance instead, never earned as a prize. */
export const ENTITLEMENT_REWARD_TYPES = ['free_item', 'discount', 'voucher'] as const;

const issue = (path: string, code: string, message: string): ConfigIssue => ({ path, code, message });
const zodIssues = (error: z.ZodError): ConfigIssue[] => error.issues.map((i) => issue(i.path.join('.') || 'config', i.code, i.message));
const moneyIssue = (path: string, error: unknown): ConfigIssue =>
  error instanceof MoneyError ? issue(path, error.code, error.message) : issue(path, 'INVALID', 'Invalid value.');

// ---- Business-local time (timezone safe) -----------------------------------------------------------------------------------------------

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return typeof timeZone === 'string' && timeZone.length > 0;
  } catch {
    return false;
  }
}

export interface LocalTime {
  /** Local calendar date, YYYY-MM-DD. */
  readonly date: string;
  /** Whole days since 1970-01-01 of the LOCAL date (an integer independent of daylight saving). */
  readonly dayNumber: number;
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  readonly weekday: number;
  /** Minutes after local midnight, 0 to 1439. */
  readonly minutes: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f;
}

/**
 * The business-local date and time of an instant. The database UTC day is NEVER a substitute: 23:30 UTC is already tomorrow in Kuwait. An instant
 * always has exactly one local reading, so a daylight-saving gap or overlap cannot make this ambiguous.
 */
export function localTimeOf(instant: Date, timeZone: string): LocalTime {
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(instant).map((p) => [p.type, p.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const dayNumber = Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
  const weekday = ((dayNumber + 3) % 7) + 1; // 1970-01-01 was a Thursday (4)
  return { date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, dayNumber, weekday, minutes: hour * 60 + minute };
}

/** Period index of a local time: the local day number, or the Monday-based local week number. */
export function periodIndexOf(local: LocalTime, period: 'day' | 'week'): number {
  return period === 'day' ? local.dayNumber : Math.floor((local.dayNumber + 3) / 7);
}

// ---- Shared facts and results ----------------------------------------------------------------------------------------------------------

export type ProgressEvent =
  | { readonly kind: 'purchase'; readonly amountMinor: bigint; readonly currency: string; readonly occurredAt: Date }
  | { readonly kind: 'visit'; readonly occurredAt: Date };

export interface EntitlementGrant {
  /** Stable key making the grant idempotent per programme and account (for example `milestone:20`). */
  readonly key: string;
  readonly rewardId: string;
}
export interface ProgressStep {
  readonly kind: string;
  readonly delta: number;
}
export interface EngineOutcome<S> {
  readonly state: S;
  readonly steps: readonly ProgressStep[];
  readonly grants: readonly EntitlementGrant[];
  readonly reason?: string;
}

const uuid = z.uuid();
const amountText = z.string().trim().min(1).max(20);

function checkMinimum(minimum: string | undefined, currency: string, path: string, issues: ConfigIssue[]): string | undefined {
  if (minimum === undefined) return undefined;
  try {
    return formatMoney(parseMoney(minimum, currency), currency);
  } catch (error) {
    issues.push(moneyIssue(path, error));
    return undefined;
  }
}

// ---- LP-04 Milestone rewards -----------------------------------------------------------------------------------------------------------

const lp04Schema = z.strictObject({
  /** purchases = verified receipts, visits = check-ins, spend = cumulative qualifying amount. A milestone is NOT a membership tier. */
  metric: z.enum(['purchases', 'visits', 'spend']),
  milestones: z.array(z.strictObject({ threshold: amountText, rewardId: uuid })).min(1).max(20),
  /** Optional minimum receipt amount for a purchase to count (purchases metric). */
  minimumPurchaseAmount: amountText.optional(),
});

export interface MilestoneState {
  readonly count: number;
  /** Cumulative qualifying spend in the business currency's minor units. */
  readonly spendMinor: number;
  readonly achieved: readonly string[];
}
export const EMPTY_MILESTONE_STATE: MilestoneState = Object.freeze({ count: 0, spendMinor: 0, achieved: Object.freeze([]) as readonly string[] });

export function validateLp04(raw: unknown, currency: string): EngineConfigResult {
  const parsed = lp04Schema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: zodIssues(parsed.error) };
  const issues: ConfigIssue[] = [];
  const minimum = checkMinimum(parsed.data.minimumPurchaseAmount, currency, 'minimumPurchaseAmount', issues);
  const milestones: { threshold: string; rewardId: string }[] = [];
  let previous = 0n;
  parsed.data.milestones.forEach((m, i) => {
    try {
      let value: bigint;
      if (parsed.data.metric === 'spend') {
        value = parseMoney(m.threshold, currency);
        milestones.push({ threshold: formatMoney(value, currency), rewardId: m.rewardId });
      } else {
        if (!/^\d{1,6}$/.test(m.threshold) || Number(m.threshold) < 1) throw new MoneyError('INVALID_FORMAT', 'A count threshold is a whole number of at least 1.');
        value = BigInt(m.threshold);
        milestones.push({ threshold: String(Number(m.threshold)), rewardId: m.rewardId });
      }
      if (value <= previous) issues.push(issue(`milestones.${i}.threshold`, 'NOT_ASCENDING', 'Thresholds must be strictly ascending.'));
      previous = value;
    } catch (error) {
      issues.push(moneyIssue(`milestones.${i}.threshold`, error));
    }
  });
  if (issues.length > 0) return { ok: false, errors: issues };
  const config: Record<string, unknown> = { metric: parsed.data.metric, milestones };
  if (minimum !== undefined) config.minimumPurchaseAmount = minimum;
  return { ok: true, config, rewardIds: milestones.map((m) => m.rewardId) };
}

export function milestoneStateFrom(counters: Record<string, unknown> | null | undefined): MilestoneState {
  const count = Number(counters?.count);
  const spend = Number(counters?.spendMinor);
  const achieved = Array.isArray(counters?.achieved) ? (counters.achieved as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  return { count: Number.isInteger(count) && count >= 0 ? count : 0, spendMinor: Number.isSafeInteger(spend) && spend >= 0 ? spend : 0, achieved };
}

/** Applies one verified event to a milestone ladder; every threshold newly reached yields exactly one grant, once for the lifetime of the programme. */
export function applyMilestone(config: Record<string, unknown>, state: MilestoneState, event: ProgressEvent): EngineOutcome<MilestoneState> {
  const metric = config.metric as 'purchases' | 'visits' | 'spend';
  const milestones = config.milestones as { threshold: string; rewardId: string }[];
  let count = state.count;
  let spendMinor = state.spendMinor;
  const steps: ProgressStep[] = [];
  if (metric === 'visits') {
    if (event.kind !== 'visit') return { state, steps, grants: [], reason: 'EVENT_NOT_COUNTED' };
    count += 1;
    steps.push({ kind: 'visit', delta: 1 });
  } else {
    if (event.kind !== 'purchase') return { state, steps, grants: [], reason: 'EVENT_NOT_COUNTED' };
    const minimum = config.minimumPurchaseAmount;
    if (metric === 'purchases' && typeof minimum === 'string' && event.amountMinor < parseMoney(minimum, event.currency)) {
      return { state, steps, grants: [], reason: 'BELOW_MINIMUM' };
    }
    if (metric === 'purchases') {
      count += 1;
      steps.push({ kind: 'purchase', delta: 1 });
    } else {
      spendMinor += Number(event.amountMinor);
      steps.push({ kind: 'spend', delta: Number(event.amountMinor) });
    }
  }
  const achieved = new Set(state.achieved);
  const grants: EntitlementGrant[] = [];
  for (const m of milestones) {
    const reached = metric === 'spend' ? BigInt(spendMinor) >= parseMoney(m.threshold, (event as { currency: string }).currency) : count >= Number(m.threshold);
    if (reached && !achieved.has(m.threshold)) {
      achieved.add(m.threshold);
      grants.push({ key: `milestone:${m.threshold}`, rewardId: m.rewardId });
      steps.push({ kind: 'milestone_achieved', delta: 0 });
    }
  }
  return { state: { count, spendMinor, achieved: [...achieved] }, steps, grants };
}

// ---- LP-05 Streak rewards --------------------------------------------------------------------------------------------------------------

const lp05Schema = z.strictObject({
  period: z.enum(['day', 'week']),
  requiredPeriods: z.number().int().min(2).max(365),
  /** How many whole periods may be missed inside a streak without breaking it (0 = none). */
  gracePeriods: z.number().int().min(0).max(3),
  evidence: z.enum(['purchase', 'visit']),
  minimumPurchaseAmount: amountText.optional(),
  rewardId: uuid,
});

export interface StreakState {
  readonly streak: number;
  /** The local period index of the last counted period, or null. */
  readonly lastPeriod: number | null;
  /** Streaks completed so far. */
  readonly cycle: number;
}
export const EMPTY_STREAK_STATE: StreakState = Object.freeze({ streak: 0, lastPeriod: null, cycle: 0 });

export function validateLp05(raw: unknown, currency: string): EngineConfigResult {
  const parsed = lp05Schema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: zodIssues(parsed.error) };
  const issues: ConfigIssue[] = [];
  const minimum = checkMinimum(parsed.data.minimumPurchaseAmount, currency, 'minimumPurchaseAmount', issues);
  if (parsed.data.evidence === 'visit' && parsed.data.minimumPurchaseAmount !== undefined) issues.push(issue('minimumPurchaseAmount', 'NOT_APPLICABLE', 'A minimum amount applies only to purchase evidence.'));
  if (issues.length > 0) return { ok: false, errors: issues };
  const config: Record<string, unknown> = { ...parsed.data };
  if (minimum !== undefined) config.minimumPurchaseAmount = minimum;
  return { ok: true, config, rewardIds: [parsed.data.rewardId] };
}

export function streakStateFrom(counters: Record<string, unknown> | null | undefined): StreakState {
  const streak = Number(counters?.streak);
  const cycle = Number(counters?.cycle);
  const last = counters?.lastPeriod;
  return {
    streak: Number.isInteger(streak) && streak >= 0 ? streak : 0,
    cycle: Number.isInteger(cycle) && cycle >= 0 ? cycle : 0,
    lastPeriod: typeof last === 'number' && Number.isInteger(last) ? last : null,
  };
}

/**
 * Applies one verified event to a streak using BUSINESS-LOCAL periods. Several events in one period count once; a gap larger than the grace
 * breaks the streak (this event starts a new one); an event older than the last counted period (a late replay) changes nothing.
 */
export function applyStreak(config: Record<string, unknown>, state: StreakState, event: ProgressEvent, timeZone: string): EngineOutcome<StreakState> {
  const evidence = config.evidence as 'purchase' | 'visit';
  if (event.kind !== evidence) return { state, steps: [], grants: [], reason: 'EVENT_NOT_COUNTED' };
  const minimum = config.minimumPurchaseAmount;
  if (event.kind === 'purchase' && typeof minimum === 'string' && event.amountMinor < parseMoney(minimum, event.currency)) {
    return { state, steps: [], grants: [], reason: 'BELOW_MINIMUM' };
  }
  const period = periodIndexOf(localTimeOf(event.occurredAt, timeZone), config.period as 'day' | 'week');
  if (state.lastPeriod !== null && period < state.lastPeriod) return { state, steps: [], grants: [], reason: 'OUT_OF_ORDER' };
  if (state.lastPeriod !== null && period === state.lastPeriod) return { state, steps: [], grants: [], reason: 'SAME_PERIOD' };
  const required = Number(config.requiredPeriods);
  const grace = Number(config.gracePeriods);
  const steps: ProgressStep[] = [];
  let streak: number;
  if (state.lastPeriod === null) streak = 1;
  else if (period - state.lastPeriod - 1 <= grace) streak = state.streak + 1;
  else {
    if (state.streak > 0) steps.push({ kind: 'streak_broken', delta: -state.streak });
    streak = 1;
  }
  steps.push({ kind: 'streak_period', delta: 1 });
  if (streak >= required) {
    steps.push({ kind: 'streak_completed', delta: 0 });
    return { state: { streak: 0, lastPeriod: period, cycle: state.cycle + 1 }, steps, grants: [{ key: `streak:${state.cycle + 1}`, rewardId: String(config.rewardId) }] };
  }
  return { state: { streak, lastPeriod: period, cycle: state.cycle }, steps, grants: [] };
}

// ---- LP-06 Off-peak rewards ------------------------------------------------------------------------------------------------------------

const timeText = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const windowSchema = z
  .strictObject({
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    start: timeText,
    end: timeText,
    /** Exactly one of: a multiplier on the base earning, or a fixed bonus per purchase. */
    multiplier: z.string().trim().min(1).max(8).optional(),
    bonusPoints: z.number().int().min(1).max(100_000).optional(),
  })
  .refine((w) => (w.multiplier === undefined) !== (w.bonusPoints === undefined), { message: 'Set exactly one of multiplier or bonusPoints.' });

const lp06Schema = z.strictObject({
  pointsPerCurrencyUnit: z.string().trim().min(1).max(20),
  pointsPerCheckin: z.number().int().min(0).max(100_000).default(0),
  windows: z.array(windowSchema).min(1).max(10),
  /** Local calendar dates (business timezone), inclusive. Optional. */
  effectiveFrom: z.iso.date().optional(),
  effectiveUntil: z.iso.date().optional(),
});

const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export function validateLp06(raw: unknown): EngineConfigResult {
  const parsed = lp06Schema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: zodIssues(parsed.error) };
  const issues: ConfigIssue[] = [];
  let base: Rate | undefined;
  try {
    base = parseRate(parsed.data.pointsPerCurrencyUnit);
  } catch (error) {
    issues.push(moneyIssue('pointsPerCurrencyUnit', error));
  }
  const byDay = new Map<number, { start: number; end: number }[]>();
  const windows = parsed.data.windows.map((w, i) => {
    const start = toMinutes(w.start);
    const end = toMinutes(w.end);
    if (end <= start) issues.push(issue(`windows.${i}`, 'BAD_WINDOW', 'A window must end after it starts, on the same day (split a window that crosses midnight).'));
    let multiplier: string | undefined;
    if (w.multiplier !== undefined) {
      try {
        const m = parseRate(w.multiplier);
        if (m.scale > 2) throw new MoneyError('INVALID_RATE', 'A multiplier has at most 2 decimal places.');
        if (m.numerator < 10n ** BigInt(m.scale)) throw new MoneyError('INVALID_RATE', 'A multiplier is at least 1.');
        if (m.numerator > 10n * 10n ** BigInt(m.scale)) throw new MoneyError('INVALID_RATE', 'A multiplier is at most 10.');
        multiplier = w.multiplier.includes('.') ? w.multiplier : `${w.multiplier}`;
      } catch (error) {
        issues.push(moneyIssue(`windows.${i}.multiplier`, error));
      }
    }
    for (const day of new Set(w.days)) {
      const list = byDay.get(day) ?? [];
      if (list.some((o) => start < o.end && o.start < end)) issues.push(issue(`windows.${i}`, 'OVERLAP', 'Time windows must not overlap.'));
      list.push({ start, end });
      byDay.set(day, list);
    }
    return { days: [...new Set(w.days)].sort((a, b) => a - b), start: w.start, end: w.end, ...(multiplier !== undefined ? { multiplier } : {}), ...(w.bonusPoints !== undefined ? { bonusPoints: w.bonusPoints } : {}) };
  });
  if (parsed.data.effectiveFrom && parsed.data.effectiveUntil && parsed.data.effectiveUntil < parsed.data.effectiveFrom) {
    issues.push(issue('effectiveUntil', 'BAD_RANGE', 'The end date must not be before the start date.'));
  }
  if (issues.length > 0 || !base) return { ok: false, errors: issues };
  const config: Record<string, unknown> = {
    pointsPerCurrencyUnit: `${base.numerator / 10n ** BigInt(base.scale)}${base.scale ? '.' + (base.numerator % 10n ** BigInt(base.scale)).toString().padStart(base.scale, '0') : ''}`,
    pointsPerCheckin: parsed.data.pointsPerCheckin,
    windows,
    ...(parsed.data.effectiveFrom ? { effectiveFrom: parsed.data.effectiveFrom } : {}),
    ...(parsed.data.effectiveUntil ? { effectiveUntil: parsed.data.effectiveUntil } : {}),
  };
  return { ok: true, config, rewardIds: [] };
}

export interface OffPeakResult {
  readonly basePoints: number;
  readonly bonusPoints: number;
  readonly points: number;
  /** The window that applied, as "<days> <start>-<end>", or null. */
  readonly window: string | null;
}

/** Points for a purchase: base (floor(amount x rate)) plus the off-peak effect of the ONE window the server-recorded local time falls in. */
export function earnOffPeak(config: Record<string, unknown>, amountMinor: bigint, currency: string, occurredAt: Date, timeZone: string): OffPeakResult {
  const rate = parseRate(String(config.pointsPerCurrencyUnit));
  const unit = 10n ** BigInt(currencyExponent(currency));
  const base = Number((amountMinor * rate.numerator) / (unit * 10n ** BigInt(rate.scale)));
  const local = localTimeOf(occurredAt, timeZone);
  const from = config.effectiveFrom as string | undefined;
  const until = config.effectiveUntil as string | undefined;
  const effective = (!from || local.date >= from) && (!until || local.date <= until);
  const windows = config.windows as { days: number[]; start: string; end: string; multiplier?: string; bonusPoints?: number }[];
  const hit = effective ? windows.find((w) => w.days.includes(local.weekday) && local.minutes >= toMinutes(w.start) && local.minutes < toMinutes(w.end)) : undefined;
  if (!hit) return { basePoints: base, bonusPoints: 0, points: base, window: null };
  let total = base;
  if (hit.multiplier !== undefined) {
    const m = parseRate(hit.multiplier);
    total = Number((amountMinor * rate.numerator * m.numerator) / (unit * 10n ** BigInt(rate.scale) * 10n ** BigInt(m.scale)));
  } else {
    total = base + Number(hit.bonusPoints);
  }
  return { basePoints: base, bonusPoints: total - base, points: total, window: `${hit.days.join(',')} ${hit.start}-${hit.end}` };
}

// ---- LP-07 Missions and challenges -----------------------------------------------------------------------------------------------------

const missionSchema = z.strictObject({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  /** purchases = verified receipts, spend = qualifying amount, visits = check-ins. Ratings, reviews and feedback are never an objective (RW-D6). */
  objective: z.enum(['purchases', 'spend', 'visits']),
  target: amountText,
  windowDays: z.number().int().min(1).max(365),
  minimumPurchaseAmount: amountText.optional(),
  rewardId: uuid,
});
const lp07Schema = z.strictObject({ missions: z.array(missionSchema).min(1).max(10) });

export interface MissionProgress {
  readonly startedAt: string;
  readonly count: number;
  readonly spendMinor: number;
  readonly status: 'active' | 'completed';
}
export interface MissionState {
  readonly missions: Readonly<Record<string, MissionProgress>>;
}
export const EMPTY_MISSION_STATE: MissionState = Object.freeze({ missions: Object.freeze({}) as Record<string, MissionProgress> });

export function validateLp07(raw: unknown, currency: string): EngineConfigResult {
  const parsed = lp07Schema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: zodIssues(parsed.error) };
  const issues: ConfigIssue[] = [];
  const seen = new Set<string>();
  const missions = parsed.data.missions.map((m, i) => {
    if (seen.has(m.key)) issues.push(issue(`missions.${i}.key`, 'DUPLICATE', 'Mission keys must be unique.'));
    seen.add(m.key);
    let target = m.target;
    try {
      if (m.objective === 'spend') target = formatMoney(parseMoney(m.target, currency), currency);
      else {
        if (!/^\d{1,6}$/.test(m.target) || Number(m.target) < 1) throw new MoneyError('INVALID_FORMAT', 'A count target is a whole number of at least 1.');
        target = String(Number(m.target));
      }
    } catch (error) {
      issues.push(moneyIssue(`missions.${i}.target`, error));
    }
    const minimum = m.objective === 'purchases' ? checkMinimum(m.minimumPurchaseAmount, currency, `missions.${i}.minimumPurchaseAmount`, issues) : undefined;
    if (m.objective !== 'purchases' && m.minimumPurchaseAmount !== undefined) issues.push(issue(`missions.${i}.minimumPurchaseAmount`, 'NOT_APPLICABLE', 'A minimum amount applies only to a purchase-count objective.'));
    return { key: m.key, objective: m.objective, target, windowDays: m.windowDays, ...(minimum !== undefined ? { minimumPurchaseAmount: minimum } : {}), rewardId: m.rewardId };
  });
  if (issues.length > 0) return { ok: false, errors: issues };
  return { ok: true, config: { missions }, rewardIds: missions.map((m) => m.rewardId) };
}

export function missionStateFrom(counters: Record<string, unknown> | null | undefined): MissionState {
  const raw = counters?.missions;
  const out: Record<string, MissionProgress> = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const v = value as Record<string, unknown>;
      const startedAt = typeof v?.startedAt === 'string' && !Number.isNaN(Date.parse(v.startedAt)) ? v.startedAt : null;
      if (!startedAt) continue;
      const count = Number(v.count);
      const spend = Number(v.spendMinor);
      out[key] = { startedAt, count: Number.isInteger(count) && count >= 0 ? count : 0, spendMinor: Number.isSafeInteger(spend) && spend >= 0 ? spend : 0, status: v.status === 'completed' ? 'completed' : 'active' };
    }
  }
  return { missions: out };
}

const DAY_MS = 86_400_000;

/** Applies one verified event to every mission. A completed mission never pays twice; an expired unfinished mission restarts with this event. */
export function applyMissions(config: Record<string, unknown>, state: MissionState, event: ProgressEvent): EngineOutcome<MissionState> {
  const missions = config.missions as { key: string; objective: 'purchases' | 'spend' | 'visits'; target: string; windowDays: number; minimumPurchaseAmount?: string; rewardId: string }[];
  const next: Record<string, MissionProgress> = { ...state.missions };
  const steps: ProgressStep[] = [];
  const grants: EntitlementGrant[] = [];
  for (const m of missions) {
    const wanted = m.objective === 'visits' ? event.kind === 'visit' : event.kind === 'purchase';
    if (!wanted) continue;
    if (m.objective === 'purchases' && event.kind === 'purchase' && m.minimumPurchaseAmount && event.amountMinor < parseMoney(m.minimumPurchaseAmount, event.currency)) continue;
    let progress = next[m.key];
    if (progress?.status === 'completed') continue;
    if (progress && event.occurredAt.getTime() > Date.parse(progress.startedAt) + m.windowDays * DAY_MS) {
      steps.push({ kind: `mission_expired:${m.key}`, delta: -(m.objective === 'spend' ? progress.spendMinor : progress.count) });
      progress = undefined;
    }
    let count = progress?.count ?? 0;
    let spendMinor = progress?.spendMinor ?? 0;
    const startedAt = progress?.startedAt ?? event.occurredAt.toISOString();
    if (m.objective === 'spend' && event.kind === 'purchase') spendMinor += Number(event.amountMinor);
    else count += 1;
    steps.push({ kind: `mission_progress:${m.key}`, delta: m.objective === 'spend' && event.kind === 'purchase' ? Number(event.amountMinor) : 1 });
    const done = m.objective === 'spend' ? BigInt(spendMinor) >= parseMoney(m.target, (event as { currency: string }).currency) : count >= Number(m.target);
    if (done) {
      next[m.key] = { startedAt, count, spendMinor, status: 'completed' };
      grants.push({ key: `mission:${m.key}`, rewardId: m.rewardId });
      steps.push({ kind: `mission_completed:${m.key}`, delta: 0 });
    } else {
      next[m.key] = { startedAt, count, spendMinor, status: 'active' };
    }
  }
  return { state: { missions: next }, steps, grants };
}
