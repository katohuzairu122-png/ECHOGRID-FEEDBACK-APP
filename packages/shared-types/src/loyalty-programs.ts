import { z } from 'zod';
import { currencyExponent, formatMoney, MoneyError, parseMoney, parseRate, pointsFor } from './loyalty-money';

/**
 * Primary loyalty programmes (LP-01..LP-08), shared by the API and the web app so the customer-earning PREVIEW and the backend use exactly
 * the same rules (REWARD-CONFIG-01 section 6, LOYALTY-PROGRAMME-COMPLETION section 6.2). Pure and deterministic: no clock, no I/O.
 */
export const LOYALTY_PROGRAM_TYPES = ['LP-01', 'LP-02', 'LP-03', 'LP-04', 'LP-05', 'LP-06', 'LP-07', 'LP-08'] as const;
export type LoyaltyProgramType = (typeof LOYALTY_PROGRAM_TYPES)[number];
/** draft -> validated -> active -> inactive -> retired. No other lifecycle states exist. */
export const LOYALTY_PROGRAM_STATUSES = ['draft', 'validated', 'active', 'inactive', 'retired'] as const;
export type LoyaltyProgramStatus = (typeof LOYALTY_PROGRAM_STATUSES)[number];

export type ProgramUnavailableReason = 'IN_DEVELOPMENT' | 'NEEDS_ITEM_LEVEL_EVIDENCE' | 'NEEDS_OWNER_DECISION';

export interface ProgramRegistryEntry {
  readonly type: LoyaltyProgramType;
  readonly available: boolean;
  /** Present exactly when `available` is false. */
  readonly unavailableReason?: ProgramUnavailableReason;
}

/**
 * The canonical availability registry (LOYALTY-PROGRAMME-COMPLETION section 4). A programme is selectable ONLY when its earning behaviour,
 * customer progress, reward integration and tests are complete. Move a type into this set in the same change that completes it, never earlier.
 */
const AVAILABLE_PROGRAM_TYPES: ReadonlySet<LoyaltyProgramType> = new Set<LoyaltyProgramType>(['LP-01', 'LP-02', 'LP-03']);
const UNAVAILABLE_REASONS: Readonly<Partial<Record<LoyaltyProgramType, ProgramUnavailableReason>>> = {
  // LP-08 needs verified item-level purchase evidence that the platform does not capture (RW-D3). It stays unavailable regardless of code.
  'LP-08': 'NEEDS_ITEM_LEVEL_EVIDENCE',
};

export function programRegistry(): readonly ProgramRegistryEntry[] {
  return LOYALTY_PROGRAM_TYPES.map((type) =>
    AVAILABLE_PROGRAM_TYPES.has(type)
      ? { type, available: true }
      : { type, available: false, unavailableReason: UNAVAILABLE_REASONS[type] ?? 'IN_DEVELOPMENT' },
  );
}

export function isProgramAvailable(type: string): type is LoyaltyProgramType {
  return (LOYALTY_PROGRAM_TYPES as readonly string[]).includes(type) && AVAILABLE_PROGRAM_TYPES.has(type as LoyaltyProgramType);
}

// ---- Configuration schemas -------------------------------------------------------------------------------------------------------------

const checkinPoints = z.number().int().min(0).max(100_000);
const rateText = z.string().trim().min(1).max(20);

/** LP-03 Spend and earn: points per currency unit (exact decimal), optional check-in points, floor rounding. */
export const lp03ConfigSchema = z.strictObject({
  pointsPerCurrencyUnit: rateText,
  pointsPerCheckin: checkinPoints.default(0),
  rounding: z.literal('floor').default('floor'),
  /** Set only by the pre-programme backfill: the programme reproduces the business's existing earning. */
  legacy: z.boolean().optional(),
});
export type Lp03Config = z.infer<typeof lp03ConfigSchema>;

/** LP-02 Fixed points per purchase: a fixed award for each qualifying purchase, regardless of its value. */
export const lp02ConfigSchema = z.strictObject({
  pointsPerPurchase: z.number().int().min(1).max(100_000),
  /** Optional minimum purchase amount, in the business currency's own precision. */
  minimumPurchaseAmount: z.string().trim().min(1).max(20).optional(),
  /** Fixed points per CHECK-IN is a different thing; it defaults to none. */
  pointsPerCheckin: checkinPoints.default(0),
});
export type Lp02Config = z.infer<typeof lp02ConfigSchema>;

/**
 * LP-01 Buy X, get Y free (RW-D4): one digital stamp per verified eligible receipt, a configurable threshold, and a free-item reward from the
 * business's own catalogue. Expiry and reset are REQUIRED fields, never defaulted: the Owner must state them before the programme can be activated
 * (`stampExpiryDays: null` means "stamps never expire", said explicitly).
 */
export const lp01ConfigSchema = z.strictObject({
  stampThreshold: z.number().int().min(2).max(50),
  /** The free-item reward (RW-03) the completed card entitles the customer to. Existence and type are checked against the business catalogue. */
  rewardId: z.uuid(),
  /** Optional minimum receipt amount for a stamp, in the business currency's own precision. */
  minimumPurchaseAmount: z.string().trim().min(1).max(20).optional(),
  /** The card expires this many days after its FIRST stamp; the stamps are then discarded. null = never (explicit). */
  stampExpiryDays: z.number().int().min(1).max(3650).nullable(),
  /** What happens to the card when it is completed: it starts again from zero. */
  resetPolicy: z.literal('on_completion'),
});
export type Lp01Config = z.infer<typeof lp01ConfigSchema>;

export type ProgramConfig = Lp01Config | Lp02Config | Lp03Config;

export interface ProgramConfigIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}
export type ProgramConfigResult =
  | { readonly ok: true; readonly config: Record<string, unknown> }
  | { readonly ok: false; readonly errors: readonly ProgramConfigIssue[] };

const MAX_RATE = 100_000n;

function moneyIssue(path: string, error: unknown): ProgramConfigIssue {
  return error instanceof MoneyError
    ? { path, code: error.code, message: error.message }
    : { path, code: 'INVALID', message: 'Invalid value.' };
}

/**
 * Validates and NORMALISES a configuration for one programme type. Normalisation makes equal configurations byte-identical (rates and
 * amounts are re-formatted from their exact parsed value), so version hashes are meaningful. Unavailable types never validate.
 */
export function validateProgramConfig(type: string, raw: unknown, context: { currency: string }): ProgramConfigResult {
  if (!isProgramAvailable(type)) {
    return { ok: false, errors: [{ path: 'type', code: 'PROGRAM_UNAVAILABLE', message: 'This programme is not available for activation.' }] };
  }
  const issues: ProgramConfigIssue[] = [];
  const schemaIssues = (error: z.ZodError) => error.issues.map((i) => ({ path: i.path.join('.') || 'config', code: i.code, message: i.message }));

  if (type === 'LP-03') {
    const parsed = lp03ConfigSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, errors: schemaIssues(parsed.error) };
    try {
      const rate = parseRate(parsed.data.pointsPerCurrencyUnit);
      if (rate.numerator / 10n ** BigInt(rate.scale) > MAX_RATE) issues.push({ path: 'pointsPerCurrencyUnit', code: 'TOO_LARGE', message: 'Rate is above the maximum allowed.' });
      if (issues.length === 0) {
        const normalised = formatRate(rate.numerator, rate.scale);
        return { ok: true, config: { ...parsed.data, pointsPerCurrencyUnit: normalised } };
      }
    } catch (error) {
      issues.push(moneyIssue('pointsPerCurrencyUnit', error));
    }
    return { ok: false, errors: issues };
  }

  if (type === 'LP-01') {
    const parsed = lp01ConfigSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, errors: schemaIssues(parsed.error) };
    const config: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.minimumPurchaseAmount !== undefined) {
      try {
        config.minimumPurchaseAmount = formatMoney(parseMoney(parsed.data.minimumPurchaseAmount, context.currency), context.currency);
      } catch (error) {
        issues.push(moneyIssue('minimumPurchaseAmount', error));
      }
    }
    return issues.length === 0 ? { ok: true, config } : { ok: false, errors: issues };
  }

  // LP-02
  const parsed = lp02ConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: schemaIssues(parsed.error) };
  const config: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.minimumPurchaseAmount !== undefined) {
    try {
      config.minimumPurchaseAmount = formatMoney(parseMoney(parsed.data.minimumPurchaseAmount, context.currency), context.currency);
    } catch (error) {
      issues.push(moneyIssue('minimumPurchaseAmount', error));
    }
  }
  return issues.length === 0 ? { ok: true, config } : { ok: false, errors: issues };
}

function formatRate(numerator: bigint, scale: number): string {
  if (scale === 0) return numerator.toString();
  const unit = 10n ** BigInt(scale);
  return `${numerator / unit}.${(numerator % unit).toString().padStart(scale, '0')}`;
}

// ---- Earning (pure) --------------------------------------------------------------------------------------------------------------------

export interface PurchaseFact {
  /** The verified qualifying amount in the business currency's minor units. */
  readonly amountMinor: bigint;
  readonly currency: string;
}
export interface EarningResult {
  readonly points: number;
  readonly qualifying: boolean;
  readonly reason?: 'BELOW_MINIMUM' | 'NO_POINTS_PROGRAM';
}

/** Points a purchase earns under a validated, normalised configuration. Never reads a clock or any caller-supplied time. */
export function earnForPurchase(type: LoyaltyProgramType, config: Record<string, unknown>, fact: PurchaseFact): EarningResult {
  if (type === 'LP-03') {
    const points = pointsFor(fact.amountMinor, fact.currency, parseRate(String(config.pointsPerCurrencyUnit)));
    return { points, qualifying: true };
  }
  if (type === 'LP-02') {
    const minimum = config.minimumPurchaseAmount;
    if (typeof minimum === 'string' && fact.amountMinor < parseMoney(minimum, fact.currency)) {
      return { points: 0, qualifying: false, reason: 'BELOW_MINIMUM' };
    }
    return { points: Number(config.pointsPerPurchase), qualifying: true };
  }
  if (type === 'LP-01') {
    // A stamp programme earns stamps, not points: the purchase is recorded with zero points and its stamp is handled by the stamp engine.
    const minimum = config.minimumPurchaseAmount;
    if (typeof minimum === 'string' && fact.amountMinor < parseMoney(minimum, fact.currency)) {
      return { points: 0, qualifying: false, reason: 'BELOW_MINIMUM' };
    }
    return { points: 0, qualifying: true };
  }
  return { points: 0, qualifying: false, reason: 'NO_POINTS_PROGRAM' };
}

/** Points a check-in earns. Programmes without a check-in setting earn none; this is deliberately distinct from per-purchase earning. */
export function earnForCheckin(type: LoyaltyProgramType, config: Record<string, unknown>): number {
  if (type === 'LP-03' || type === 'LP-02') return Number(config.pointsPerCheckin ?? 0);
  return 0;
}

/** Customer-facing example lines for the configuration screen preview (same rules as the backend). */
export function previewPurchases(
  type: LoyaltyProgramType,
  config: Record<string, unknown>,
  currency: string,
  sampleAmounts: readonly string[],
): { amount: string; points: number; qualifying: boolean }[] {
  const out: { amount: string; points: number; qualifying: boolean }[] = [];
  for (const sample of sampleAmounts) {
    try {
      const minor = parseMoney(sample, currency);
      const result = earnForPurchase(type, config, { amountMinor: minor, currency });
      out.push({ amount: formatMoney(minor, currency), points: result.points, qualifying: result.qualifying });
    } catch {
      // A sample the currency cannot represent is simply left out of the preview.
    }
  }
  return out;
}

export { currencyExponent };


// ---- LP-01 stamp card (pure) -----------------------------------------------------------------------------------------------------------

export interface StampState {
  readonly stamps: number;
  /** The number of cards completed so far. */
  readonly cycle: number;
  /** When the current card got its first stamp (ISO), or null for an empty card. */
  readonly cycleStartedAt: string | null;
}
export const EMPTY_STAMP_STATE: StampState = Object.freeze({ stamps: 0, cycle: 0, cycleStartedAt: null });

export interface StampOutcome {
  readonly state: StampState;
  /** A stamp was added for this receipt. */
  readonly stamped: boolean;
  /** The previous card had passed its expiry and its stamps were discarded before this receipt counted. */
  readonly expiredStamps: number;
  /** This stamp completed a card: the customer earned the reward and the card restarted. */
  readonly completedCycle: number | null;
  readonly reason?: 'BELOW_MINIMUM';
}

/** Reads a persisted counters object defensively: anything unexpected is treated as an empty card, never as a larger one. */
export function stampStateFrom(counters: Record<string, unknown> | null | undefined): StampState {
  const stamps = Number(counters?.stamps);
  const cycle = Number(counters?.cycle);
  const startedAt = counters?.cycleStartedAt;
  return {
    stamps: Number.isInteger(stamps) && stamps >= 0 ? stamps : 0,
    cycle: Number.isInteger(cycle) && cycle >= 0 ? cycle : 0,
    cycleStartedAt: typeof startedAt === 'string' && !Number.isNaN(Date.parse(startedAt)) ? startedAt : null,
  };
}

const DAY_MS = 86_400_000;

/**
 * Applies ONE verified receipt to a stamp card. `now` is the SERVER time of the recorded purchase event: neither a cashier nor a customer can supply
 * it. One receipt yields at most one stamp (the caller enforces one application per purchase event); an expired card is emptied first.
 */
export function applyStamp(config: Record<string, unknown>, state: StampState, fact: PurchaseFact & { readonly now: Date }): StampOutcome {
  const minimum = config.minimumPurchaseAmount;
  if (typeof minimum === 'string' && fact.amountMinor < parseMoney(minimum, fact.currency)) {
    return { state, stamped: false, expiredStamps: 0, completedCycle: null, reason: 'BELOW_MINIMUM' };
  }
  const threshold = Number(config.stampThreshold);
  const expiryDays = config.stampExpiryDays;
  let working = state;
  let expiredStamps = 0;
  if (typeof expiryDays === 'number' && working.cycleStartedAt !== null && working.stamps > 0) {
    if (fact.now.getTime() > Date.parse(working.cycleStartedAt) + expiryDays * DAY_MS) {
      expiredStamps = working.stamps;
      working = { stamps: 0, cycle: working.cycle, cycleStartedAt: null };
    }
  }
  const stamps = working.stamps + 1;
  const cycleStartedAt = working.cycleStartedAt ?? fact.now.toISOString();
  if (stamps >= threshold) {
    return { state: { stamps: 0, cycle: working.cycle + 1, cycleStartedAt: null }, stamped: true, expiredStamps, completedCycle: working.cycle + 1 };
  }
  return { state: { stamps, cycle: working.cycle, cycleStartedAt }, stamped: true, expiredStamps, completedCycle: null };
}
