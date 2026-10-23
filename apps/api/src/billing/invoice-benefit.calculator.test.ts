import { describe, it, expect } from 'vitest';
import { INVOICE_BENEFIT_POLICY_V1, computeInvoiceBenefit, eligibleBaseMinor, type InvoiceBenefitEvidence, type InvoiceBenefitLine, type InvoiceBenefitRequest } from './invoice-benefit.calculator';

const B = 'biz-1';
const line = (over: Partial<InvoiceBenefitLine> = {}): InvoiceBenefitLine => ({ id: 'li_1', category: 'recurring_base', amountMinor: 10_000, currency: 'usd', ...over });
const invoice = (over: Partial<InvoiceBenefitEvidence> = {}): InvoiceBenefitEvidence => ({
  invoiceId: 'in_1', invoiceBusinessId: B, currency: 'usd', status: 'paid', amountDueMinor: 11_000, amountPaidMinor: 11_000, interval: 'month', trialOrFree: false,
  lines: [line(), line({ id: 'li_tax', category: 'tax', amountMinor: 1_000 })], ...over,
});
const req = (over: Partial<InvoiceBenefitRequest> = {}): InvoiceBenefitRequest => ({ creditBusinessId: B, requestedUnits: 3, availableUnits: 5, ...over });
const denied = (r: ReturnType<typeof computeInvoiceBenefit>) => (r.eligible ? [] : r.reasons);

describe('PC-BENEFIT/1 calculation (owner policy: 1 PC = 1% of eligible base, max 10%)', () => {
  it('pins the versioned policy values', () => {
    expect(INVOICE_BENEFIT_POLICY_V1).toMatchObject({ version: 'PC-BENEFIT/1', percentPerCredit: 1, maxPercent: 10, eligibleIntervals: ['month'], rounding: 'floor' });
    expect(Object.isFrozen(INVOICE_BENEFIT_POLICY_V1)).toBe(true);
  });

  it('applies N credits as N% of the base charge only; taxes never count', () => {
    const r = computeInvoiceBenefit(invoice(), req({ requestedUnits: 3 }));
    expect(r).toMatchObject({ eligible: true, unitsToApply: 3, eligibleBaseMinor: 10_000, benefitMinor: 300, percentApplied: 3, unitsNotApplied: 0, currency: 'usd' });
  });

  it('caps at 10% and leaves the excess unapplied', () => {
    const r = computeInvoiceBenefit(invoice(), req({ requestedUnits: 25, availableUnits: 40 }));
    expect(r).toMatchObject({ eligible: true, unitsToApply: 10, benefitMinor: 1_000, percentApplied: 10, unitsNotApplied: 15 });
  });

  it('never applies more units than are available', () => {
    expect(computeInvoiceBenefit(invoice(), req({ requestedUnits: 8, availableUnits: 2 }))).toMatchObject({ eligible: true, unitsToApply: 2, benefitMinor: 200, unitsNotApplied: 6 });
  });

  it('floors to whole minor units (never grants more than the stated percentage)', () => {
    const r = computeInvoiceBenefit(invoice({ lines: [line({ amountMinor: 999 })], amountDueMinor: 999, amountPaidMinor: 999 }), req({ requestedUnits: 3 }));
    expect(r).toMatchObject({ eligible: true, benefitMinor: 29 }); // 999 * 3 / 100 = 29.97 -> 29
  });

  it('reduces the base by the provider-attributed discount on the base line', () => {
    const r = computeInvoiceBenefit(invoice({ lines: [line({ discountMinor: 2_000 })] }), req({ requestedUnits: 10, availableUnits: 20 }));
    expect(r).toMatchObject({ eligible: true, eligibleBaseMinor: 8_000, benefitMinor: 800 });
  });

  it('excludes one-time charges, previous balances, proration and add-ons from the base', () => {
    const lines = [line(), line({ id: 'a', category: 'one_time', amountMinor: 5_000 }), line({ id: 'b', category: 'previous_balance', amountMinor: 7_000 }), line({ id: 'c', category: 'proration', amountMinor: 900 }), line({ id: 'd', category: 'add_on', amountMinor: 400 }), line({ id: 'e', category: 'other', amountMinor: 50 })];
    expect(eligibleBaseMinor(lines)).toBe(10_000);
    expect(computeInvoiceBenefit(invoice({ lines }), req({ requestedUnits: 10, availableUnits: 20 }))).toMatchObject({ eligible: true, benefitMinor: 1_000 });
  });

  it.each([
    ['yearly interval', { interval: 'year' as const }, 'INTERVAL_NOT_ELIGIBLE'],
    ['unpaid (open) invoice', { status: 'open' as const }, 'INVOICE_NOT_PAID'],
    ['partially paid invoice', { amountPaidMinor: 5_000 }, 'INVOICE_NOT_PAID'],
    ['void invoice', { status: 'void' as const }, 'INVOICE_NOT_PAID'],
    ['trial or free plan', { trialOrFree: true }, 'TRIAL_OR_FREE'],
    ['nothing due', { amountDueMinor: 0, amountPaidMinor: 0 }, 'NO_AMOUNT_DUE'],
    ['currency mismatch on a line', { lines: [line({ currency: 'eur' })] }, 'CURRENCY_MISMATCH'],
    ['two recurring base lines', { lines: [line(), line({ id: 'li_2' })] }, 'BASE_LINE_COUNT_UNSUPPORTED'],
    ['no recurring base line', { lines: [line({ category: 'one_time' })] }, 'BASE_LINE_COUNT_UNSUPPORTED'],
    ['fully discounted base', { lines: [line({ discountMinor: 10_000 })] }, 'NO_ELIGIBLE_BASE'],
  ] as const)('denies %s', (_n, over, reason) => {
    expect(denied(computeInvoiceBenefit(invoice(over), req()))).toContain(reason);
  });

  it('prohibits cross-business application', () => {
    expect(denied(computeInvoiceBenefit(invoice(), req({ creditBusinessId: 'biz-2' })))).toContain('CROSS_BUSINESS');
  });

  it('denies when there is nothing to apply', () => {
    expect(denied(computeInvoiceBenefit(invoice(), req({ requestedUnits: 0 })))).toContain('NO_UNITS');
    expect(denied(computeInvoiceBenefit(invoice(), req({ availableUnits: 0 })))).toContain('NO_UNITS');
  });

  it('fails closed on malformed input rather than computing', () => {
    const bad = (i: Partial<InvoiceBenefitEvidence>, r: Partial<InvoiceBenefitRequest> = {}) => denied(computeInvoiceBenefit(invoice(i as never), req(r as never)));
    expect(bad({ lines: [line({ amountMinor: -1 })] })).toContain('INVALID_INPUT');
    expect(bad({ lines: [line({ amountMinor: 1.5 })] })).toContain('INVALID_INPUT');
    expect(bad({ lines: [line({ amountMinor: Number.NaN })] })).toContain('INVALID_INPUT');
    expect(bad({ lines: [line({ discountMinor: 20_000 })] })).toContain('INVALID_INPUT');
    expect(bad({ currency: 'USD' })).toContain('INVALID_INPUT');
    expect(bad({ status: 'weird' as never })).toContain('INVALID_INPUT');
    expect(bad({}, { requestedUnits: 1.5 })).toContain('INVALID_INPUT');
    expect(bad({}, { requestedUnits: -2 })).toContain('INVALID_INPUT');
    expect(denied(computeInvoiceBenefit(undefined as never, undefined as never))).toContain('INVALID_INPUT');
  });

  it('never claims provider verification or consumption authority, in any outcome', () => {
    for (const r of [computeInvoiceBenefit(invoice(), req()), computeInvoiceBenefit(invoice({ interval: 'year' }), req())]) {
      expect(r.consumptionAuthorized).toBe(false);
      expect(r.providerVerified).toBe(false);
    }
  });

  it('is exact for very large bases (no floating-point loss) and refuses an unrepresentable result', () => {
    const big = 9_007_199_254_740_000; // near MAX_SAFE_INTEGER
    const r = computeInvoiceBenefit(invoice({ lines: [line({ amountMinor: big })], amountDueMinor: big, amountPaidMinor: big }), req({ requestedUnits: 10, availableUnits: 20 }));
    expect(r.eligible && r.benefitMinor).toBe(Number((BigInt(big) * 10n) / 100n));
  });

  it('property: for any base and units the benefit is deterministic, <= units% of base, <= 10% of base, and monotonic in units', () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 500; i++) {
      const base = rnd(5_000_000);
      const inv = invoice({ lines: [line({ amountMinor: base })], amountDueMinor: base + 1, amountPaidMinor: base + 1 });
      let prev = -1;
      for (let u = 0; u <= 14; u++) {
        const r = computeInvoiceBenefit(inv, req({ requestedUnits: u, availableUnits: 20 }));
        if (base === 0 || u === 0) { expect(r.eligible).toBe(false); continue; }
        if (!r.eligible) throw new Error('unexpected denial');
        expect(r).toEqual(computeInvoiceBenefit(inv, req({ requestedUnits: u, availableUnits: 20 })));
        expect(r.benefitMinor * 100).toBeLessThanOrEqual(base * r.unitsToApply);
        expect(r.benefitMinor * 10).toBeLessThanOrEqual(base);
        expect(r.benefitMinor).toBeGreaterThanOrEqual(prev);
        prev = r.benefitMinor;
      }
    }
  });
});
