import { describe, expect, it } from 'vitest';
import { divide, formatDecimal, parseDecimal, sum, DecimalError } from './decimal';
import { attributedRevenue, observedCustomerValue, predictedCustomerValue, roas, type ApprovedAttributionPolicy, type RevenueRecord, type TouchRecord } from './attribution-foundation';

const policy: ApprovedAttributionPolicy = { version: 'synthetic-1', model: 'last_touch', windowDays: 30, approvedByOwner: true }; // SYNTHETIC test policy, never a production default
const period = { start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z' };
const rev = (id: string, amount: string, over: Partial<RevenueRecord> = {}): RevenueRecord => ({ transactionId: id, amount, currency: 'USD', status: 'verified', occurredAt: '2026-01-15T00:00:00Z', customerRef: 'c1', ...over });
const touch = (level: TouchRecord['level'] = 'verified_acquisition', at = '2026-01-10T00:00:00Z', customerRef = 'c1'): TouchRecord => ({ touchId: `t-${level}-${at}`, customerRef, occurredAt: at, level });

describe('exact decimal arithmetic', () => {
  it('has no floating-point error and rounds half up', () => {
    expect(sum(['0.1', '0.2'])).toBe('0.300000'); expect(formatDecimal(parseDecimal('2.675'), 2)).toBe('2.68'); expect(formatDecimal(parseDecimal('-2.675'), 2)).toBe('-2.68');
    expect(divide('1', '3', 4)).toBe('0.3333'); expect(divide('2', '3', 4)).toBe('0.6667'); expect(divide('10.00', '4.00', 2)).toBe('2.50'); expect(divide('0', '5', 4)).toBe('0.0000');
    expect(() => divide('1', '0')).toThrow(DecimalError);
    for (const bad of ['1e3', '1,5', '', 'abc', '1.1234567', '--1', '1.']) expect(() => parseDecimal(bad), bad).toThrow(DecimalError);
  });
});

describe('attributed revenue never comes from insufficient evidence', () => {
  it('is unavailable without an approved policy, a measurement period, or any verified revenue; no model or window is ever defaulted', () => {
    const base = { touches: [touch()], revenue: [rev('a', '10.00')], measurementPeriod: period };
    for (const p of [null, undefined, { ...policy, approvedByOwner: false } as never, { ...policy, windowDays: 0 }, { ...policy, windowDays: 1.5 }]) expect(attributedRevenue({ ...base, policy: p }), JSON.stringify(p)).toEqual({ available: false, reason: 'ATTRIBUTION_POLICY_NOT_APPROVED' });
    expect(attributedRevenue({ ...base, policy, measurementPeriod: null })).toEqual({ available: false, reason: 'MEASUREMENT_PERIOD_REQUIRED' });
    expect(attributedRevenue({ ...base, policy, measurementPeriod: { start: period.end, end: period.start } })).toEqual({ available: false, reason: 'MEASUREMENT_PERIOD_INVALID' });
    expect(attributedRevenue({ ...base, policy, revenue: [] })).toEqual({ available: false, reason: 'NO_VERIFIED_REVENUE_EVIDENCE' });
  });
  it('a click, a registration or a collection is not an attributable touch; unverified revenue makes the result unavailable instead of being guessed', () => {
    expect(attributedRevenue({ policy, touches: [touch('observed_interaction')], revenue: [rev('a', '10.00')], measurementPeriod: period })).toEqual({ available: false, reason: 'NO_ATTRIBUTABLE_REVENUE' });
    expect(attributedRevenue({ policy, touches: [touch()], revenue: [rev('a', '10.00'), rev('b', '5.00', { status: 'unverified' })], measurementPeriod: period })).toEqual({ available: false, reason: 'UNVERIFIED_REVENUE_IN_PERIOD' });
  });
  it('counts only verified, in-period, in-window, customer-bound revenue; reversed and refunded revenue is handled; duplicates and mixed currencies are refused', () => {
    const r = attributedRevenue({ policy, touches: [touch()], measurementPeriod: period, revenue: [rev('a', '10.10'), rev('b', '20.20', { refundedAmount: '5.20' }), rev('c', '99.00', { status: 'reversed' }), rev('d', '7.00', { customerRef: 'other' }), rev('e', '3.00', { occurredAt: '2026-03-01T00:00:00Z' })] });
    expect(r).toEqual({ available: true, amount: '25.100000', currency: 'USD', transactions: 2 }); // 10.10 + (20.20 - 5.20); reversed/other-customer/out-of-period excluded
    expect(attributedRevenue({ policy, touches: [touch()], measurementPeriod: period, revenue: [rev('a', '1.00'), rev('a', '2.00')] })).toEqual({ available: false, reason: 'DUPLICATE_TRANSACTION_IDENTIFIER' });
    expect(attributedRevenue({ policy, touches: [touch()], measurementPeriod: period, revenue: [rev('a', '1.00'), rev('b', '2.00', { currency: 'EUR' })] })).toEqual({ available: false, reason: 'MIXED_CURRENCIES' });
    expect(attributedRevenue({ policy: { ...policy, windowDays: 3 }, touches: [touch('verified_acquisition', '2026-01-02T00:00:00Z')], measurementPeriod: period, revenue: [rev('a', '1.00')] })).toEqual({ available: false, reason: 'NO_ATTRIBUTABLE_REVENUE' }); // touch is outside the window
  });
});

describe('ROAS needs verified revenue AND verified expenditure; sponsored inventory is never spend', () => {
  const revenue = attributedRevenue({ policy, touches: [touch()], revenue: [rev('a', '300.00')], measurementPeriod: period });
  const spend = (o: Partial<{ amount: string; currency: string; verified: boolean; accountingDefinitionApproved: boolean }> = {}) => ({ amount: '100.00', currency: 'USD', verified: true, accountingDefinitionApproved: true, ...o });
  it('computes the exact ratio only when every input is present and approved', () => {
    expect(roas({ attributedRevenue: revenue, advertisingExpenditure: spend() })).toEqual({ available: true, ratio: '3.0000' });
    expect(roas({ attributedRevenue: revenue, advertisingExpenditure: spend({ amount: '70.00' }) })).toEqual({ available: true, ratio: '4.2857' });
  });
  it.each([[null, 'ADVERTISING_EXPENDITURE_UNAVAILABLE'], [spend({ verified: false }), 'ADVERTISING_EXPENDITURE_UNVERIFIED'], [spend({ accountingDefinitionApproved: false }), 'EXPENDITURE_ACCOUNTING_DEFINITION_NOT_APPROVED'], [spend({ currency: 'EUR' }), 'CURRENCY_MISMATCH'], [spend({ amount: '0.00' }), 'EXPENDITURE_NOT_POSITIVE']] as const)('unavailable: %#', (e, reason) => {
    expect(roas({ attributedRevenue: revenue, advertisingExpenditure: e as never })).toEqual({ available: false, reason });
  });
  it('is unavailable when the revenue is unavailable (never zero)', () => {
    const r = roas({ attributedRevenue: attributedRevenue({ policy: null, touches: [], revenue: [], measurementPeriod: period }), advertisingExpenditure: spend() });
    expect(r).toEqual({ available: false, reason: 'REVENUE_UNAVAILABLE:ATTRIBUTION_POLICY_NOT_APPROVED' });
  });
});

describe('customer lifetime value: historical observed only, predictions unavailable', () => {
  const def = { version: 'synthetic-1', minimumTransactions: 2, includeRefunds: 'net' as const, approvedByOwner: true as const };
  it('requires an approved definition, enough verified history and one currency; reports net observed value', () => {
    const rows = [rev('a', '10.00'), rev('b', '20.00', { refundedAmount: '5.00' }), rev('c', '4.00', { customerRef: 'c2' })];
    expect(observedCustomerValue({ definition: def, customerRef: 'c1', revenue: rows })).toEqual({ available: true, kind: 'historical_observed', amount: '25.000000', currency: 'USD', transactions: 2 });
    expect(observedCustomerValue({ definition: null, customerRef: 'c1', revenue: rows })).toEqual({ available: false, reason: 'VALUE_DEFINITION_NOT_APPROVED' });
    expect(observedCustomerValue({ definition: def, customerRef: 'c2', revenue: rows })).toEqual({ available: false, reason: 'INSUFFICIENT_TRANSACTION_HISTORY' });
    expect(observedCustomerValue({ definition: def, customerRef: 'c1', revenue: [...rows, rev('u', '1.00', { status: 'unverified' })] })).toEqual({ available: false, reason: 'UNVERIFIED_REVENUE_PRESENT' });
    expect(observedCustomerValue({ definition: def, customerRef: 'c1', revenue: [rev('a', '1.00'), rev('b', '1.00', { currency: 'EUR' })] })).toEqual({ available: false, reason: 'MIXED_OR_MISSING_CURRENCY' });
  });
  it('a predicted lifetime value is never produced', () => { expect(predictedCustomerValue()).toEqual({ available: false, reason: 'PREDICTION_MODEL_NOT_APPROVED' }); });
});
