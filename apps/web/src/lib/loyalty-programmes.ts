import {
  isProgramAvailable,
  previewPurchases,
  type LoyaltyProgramStatus,
  type LoyaltyProgramType,
  type ProgramUnavailableReason,
} from '@echo-grid-feedback/shared-types';

/** DTOs returned by the programme API (apps/api/src/loyalty/programs). */
export interface ProgrammeDto {
  id: string;
  type: LoyaltyProgramType;
  status: LoyaltyProgramStatus;
  currentVersion: number;
  legacy: boolean;
  config: Record<string, unknown>;
  activatedAt: string | null;
  deactivatedAt: string | null;
  createdAt: string;
}
export interface ProgrammesOverviewDto {
  registry: { type: LoyaltyProgramType; available: boolean; unavailableReason?: ProgramUnavailableReason }[];
  setupState: 'legacy' | 'pending' | 'configured';
  programmes: ProgrammeDto[];
}
export interface ProgrammeHistoryDto {
  events: { id: string; eventType: string; fromStatus: string | null; toStatus: string | null; version: number | null; createdAt: string }[];
  versions: { id: string; version: number; configHash: string; createdAt: string }[];
}

export interface FieldIssue {
  path: string;
  code: string;
}

type FormLike = { get(name: string): FormDataEntryValue | null; getAll(name: string): FormDataEntryValue[] };

const text = (form: FormLike, name: string): string => String(form.get(name) ?? '').trim();
const optionalText = (form: FormLike, name: string): string | undefined => {
  const value = text(form, name);
  return value === '' ? undefined : value;
};
/** A whole number from a field; a blank or unparseable value becomes NaN so the shared validator rejects it with a field-level error. */
const whole = (form: FormLike, name: string): number => {
  const value = text(form, name);
  return /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
};

/** Reads indexed rows named `<prefix>.<n>.<field>` until a row has no value at all. */
function rows(form: FormLike, prefix: string, fields: readonly string[]): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (let i = 0; i < 20; i += 1) {
    const row: Record<string, string> = {};
    let any = false;
    for (const field of fields) {
      const value = text(form, `${prefix}.${i}.${field}`);
      row[field] = value;
      if (value !== '') any = true;
    }
    if (!any && form.getAll(`${prefix}.${i}.days`).length === 0) {
      if (i > 0 || fields.length === 0) break;
      break;
    }
    out.push(row);
  }
  return out;
}

/**
 * Builds the configuration object a programme type expects from its own form. Each type has its own field set (there is no generic form); the
 * result is validated by the SAME shared rules the API enforces, then the API validates it again authoritatively.
 */
export function buildProgrammeConfig(type: LoyaltyProgramType, form: FormLike): Record<string, unknown> {
  switch (type) {
    case 'LP-03':
      return { pointsPerCurrencyUnit: text(form, 'pointsPerCurrencyUnit'), pointsPerCheckin: whole(form, 'pointsPerCheckin') };
    case 'LP-02': {
      const minimum = optionalText(form, 'minimumPurchaseAmount');
      return { pointsPerPurchase: whole(form, 'pointsPerPurchase'), pointsPerCheckin: whole(form, 'pointsPerCheckin'), ...(minimum ? { minimumPurchaseAmount: minimum } : {}) };
    }
    case 'LP-01': {
      const minimum = optionalText(form, 'minimumPurchaseAmount');
      return {
        stampThreshold: whole(form, 'stampThreshold'),
        rewardId: text(form, 'rewardId'),
        stampExpiryDays: text(form, 'expiryMode') === 'days' ? whole(form, 'stampExpiryDays') : null,
        resetPolicy: 'on_completion',
        ...(minimum ? { minimumPurchaseAmount: minimum } : {}),
      };
    }
    case 'LP-04': {
      const minimum = optionalText(form, 'minimumPurchaseAmount');
      return {
        metric: text(form, 'metric'),
        milestones: rows(form, 'milestones', ['threshold', 'rewardId']).map((r) => ({ threshold: r.threshold, rewardId: r.rewardId })),
        ...(minimum && text(form, 'metric') === 'purchases' ? { minimumPurchaseAmount: minimum } : {}),
      };
    }
    case 'LP-05': {
      const minimum = optionalText(form, 'minimumPurchaseAmount');
      const evidence = text(form, 'evidence');
      return {
        period: text(form, 'period'),
        requiredPeriods: whole(form, 'requiredPeriods'),
        gracePeriods: whole(form, 'gracePeriods'),
        evidence,
        rewardId: text(form, 'rewardId'),
        ...(minimum && evidence === 'purchase' ? { minimumPurchaseAmount: minimum } : {}),
      };
    }
    case 'LP-06': {
      const from = optionalText(form, 'effectiveFrom');
      const until = optionalText(form, 'effectiveUntil');
      const windows: Record<string, unknown>[] = [];
      for (let i = 0; i < 10; i += 1) {
        const days = form.getAll(`windows.${i}.days`).map((d) => Number(d)).filter((d) => Number.isInteger(d));
        const start = text(form, `windows.${i}.start`);
        const end = text(form, `windows.${i}.end`);
        if (days.length === 0 && start === '' && end === '') break;
        const mode = text(form, `windows.${i}.mode`);
        const value = text(form, `windows.${i}.value`);
        windows.push({ days, start, end, ...(mode === 'bonus' ? { bonusPoints: /^\d+$/.test(value) ? Number(value) : Number.NaN } : { multiplier: value }) });
      }
      return { pointsPerCurrencyUnit: text(form, 'pointsPerCurrencyUnit'), pointsPerCheckin: whole(form, 'pointsPerCheckin'), windows, ...(from ? { effectiveFrom: from } : {}), ...(until ? { effectiveUntil: until } : {}) };
    }
    case 'LP-07':
      return {
        missions: rows(form, 'missions', ['key', 'objective', 'target', 'windowDays', 'minimumPurchaseAmount', 'rewardId']).map((r) => ({
          key: r.key,
          objective: r.objective,
          target: r.target,
          windowDays: /^\d+$/.test(r.windowDays ?? '') ? Number(r.windowDays) : Number.NaN,
          ...(r.minimumPurchaseAmount && r.objective === 'purchases' ? { minimumPurchaseAmount: r.minimumPurchaseAmount } : {}),
          rewardId: r.rewardId,
        })),
      };
    default:
      return {};
  }
}

/** The rewards a programme may award as an earned prize: an active free-item, discount or voucher reward (LP-01 only a free item). */
export function eligiblePrizeRewards<T extends { type: string; status: string }>(rewards: readonly T[], type: LoyaltyProgramType): T[] {
  const allowed = type === 'LP-01' ? ['free_item'] : ['free_item', 'discount', 'voucher'];
  return rewards.filter((r) => r.status === 'active' && allowed.includes(r.type));
}

/** Customer-earning preview lines for the configuration screen (same rules as the backend where the rule is pure). */
export function earningPreview(
  type: LoyaltyProgramType,
  config: Record<string, unknown>,
  currency: string,
): { kind: 'table'; rows: { amount: string; points: number; qualifying: boolean }[] } | { kind: 'lines'; lines: { key: string; values: Record<string, string | number> }[] } {
  if ((type === 'LP-02' || type === 'LP-03') && isProgramAvailable(type)) {
    return { kind: 'table', rows: previewPurchases(type, config, currency, ['5', '20', '100']) };
  }
  if (type === 'LP-01') return { kind: 'lines', lines: [{ key: 'lp01', values: { n: Number(config.stampThreshold) } }] };
  if (type === 'LP-04') {
    return { kind: 'lines', lines: (config.milestones as { threshold: string }[]).map((m) => ({ key: `lp04_${String(config.metric)}`, values: { n: m.threshold } })) };
  }
  if (type === 'LP-05') return { kind: 'lines', lines: [{ key: `lp05_${String(config.period)}`, values: { n: Number(config.requiredPeriods) } }] };
  if (type === 'LP-06') {
    return { kind: 'lines', lines: (config.windows as { days: number[]; start: string; end: string }[]).map((w) => ({ key: 'lp06', values: { start: w.start, end: w.end, days: w.days.length } })) };
  }
  if (type === 'LP-07') {
    return { kind: 'lines', lines: (config.missions as { key: string; windowDays: number; target: string }[]).map((m) => ({ key: 'lp07', values: { name: m.key, target: m.target, days: m.windowDays } })) };
  }
  return { kind: 'lines', lines: [] };
}
