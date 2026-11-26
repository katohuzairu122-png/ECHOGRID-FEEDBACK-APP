import { divide, formatDecimal, isPositive, parseDecimal, sub, sum, DecimalError } from './decimal';

/**
 * TSH-07 attribution, revenue, ROAS and lifetime-value CALCULATION FOUNDATIONS. Pure functions: they derive nothing from insufficient evidence. Every result is either a value
 * or `{ available:false, reason }` (never 0, never an estimate). NOTHING here chooses an attribution model or window, defines a customer value, or treats sponsored inventory as
 * advertising spend: those are unapproved policy inputs, supplied explicitly or the answer is "unavailable". Drops stays payment-free; no payment concept exists in this module.
 */
export type Unavailable = { available: false; reason: string };
const na = (reason: string): Unavailable => ({ available: false, reason });
export type Available<T> = { available: true } & T;

/** The evidence ladder. A higher rung is never inferred from a lower one. */
export const EVIDENCE_LEVELS = ['observed_interaction', 'verified_acquisition', 'verified_conversion', 'recorded_transaction', 'verified_revenue', 'financially_settled_revenue'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];
export const NEVER_PROOF_OF: Record<string, readonly EvidenceLevel[]> = {
  link_click: ['verified_conversion', 'recorded_transaction', 'verified_revenue'], registration: ['verified_acquisition', 'verified_conversion'],
  collection: ['recorded_transaction', 'verified_revenue'], loyalty_activity: ['financially_settled_revenue'], cashier_recorded_purchase: ['financially_settled_revenue'],
};

/** An attribution policy is OWNER-APPROVED input: null/absent means attribution is unavailable. The model and window are never defaulted here. */
export interface ApprovedAttributionPolicy { version: string; model: 'first_touch' | 'last_touch' | 'multi_touch'; windowDays: number; approvedByOwner: true }
export interface RevenueRecord { transactionId: string; amount: string; currency: string; status: 'verified' | 'unverified' | 'reversed' | 'refunded'; refundedAmount?: string; occurredAt: string; customerRef: string }
export interface TouchRecord { touchId: string; customerRef: string; occurredAt: string; level: EvidenceLevel }

export function attributedRevenue(input: { policy: ApprovedAttributionPolicy | null | undefined; touches: readonly TouchRecord[]; revenue: readonly RevenueRecord[]; measurementPeriod: { start: string; end: string } | null | undefined }): Available<{ amount: string; currency: string; transactions: number }> | Unavailable {
  const p = input.policy;
  if (!p || p.approvedByOwner !== true || !(Number.isInteger(p.windowDays) && p.windowDays > 0)) return na('ATTRIBUTION_POLICY_NOT_APPROVED');
  if (!input.measurementPeriod) return na('MEASUREMENT_PERIOD_REQUIRED');
  const start = Date.parse(input.measurementPeriod.start); const end = Date.parse(input.measurementPeriod.end);
  if (!(start < end)) return na('MEASUREMENT_PERIOD_INVALID');
  const rows = input.revenue.filter((r) => { const t = Date.parse(r.occurredAt); return t >= start && t < end; });
  if (rows.length === 0) return na('NO_VERIFIED_REVENUE_EVIDENCE');
  if (rows.some((r) => r.status === 'unverified')) return na('UNVERIFIED_REVENUE_IN_PERIOD'); // never silently excluded or included
  const currencies = new Set(rows.map((r) => r.currency)); if (currencies.size !== 1) return na('MIXED_CURRENCIES');
  const seen = new Set<string>(); for (const r of rows) { if (seen.has(r.transactionId)) return na('DUPLICATE_TRANSACTION_IDENTIFIER'); seen.add(r.transactionId); }
  const windowMs = p.windowDays * 86_400_000; const counted: string[] = []; let n = 0;
  for (const r of rows) {
    if (r.status !== 'verified') continue; // reversed or refunded revenue does not count as revenue
    const t = Date.parse(r.occurredAt);
    const touches = input.touches.filter((x) => x.customerRef === r.customerRef && x.level !== 'observed_interaction' && Date.parse(x.occurredAt) <= t && t - Date.parse(x.occurredAt) <= windowMs);
    if (touches.length === 0) continue; // an observed interaction alone is not an attributable touch
    try { counted.push(r.refundedAmount ? sub(r.amount, r.refundedAmount) : r.amount); } catch (e) { if (e instanceof DecimalError) return na('INVALID_AMOUNT'); throw e; }
    n++;
  }
  if (n === 0) return na('NO_ATTRIBUTABLE_REVENUE');
  return { available: true, amount: sum(counted), currency: [...currencies][0]!, transactions: n };
}

/** ROAS = verified attributed revenue / verified advertising expenditure. Sponsored inventory value is NOT an input and cannot be one. */
export function roas(input: { attributedRevenue: ReturnType<typeof attributedRevenue>; advertisingExpenditure: { amount: string; currency: string; verified: boolean; accountingDefinitionApproved: boolean } | null | undefined }): Available<{ ratio: string }> | Unavailable {
  const r = input.attributedRevenue; const e = input.advertisingExpenditure;
  if (!r.available) return na(`REVENUE_UNAVAILABLE:${r.reason}`);
  if (!e) return na('ADVERTISING_EXPENDITURE_UNAVAILABLE');
  if (!e.verified) return na('ADVERTISING_EXPENDITURE_UNVERIFIED');
  if (!e.accountingDefinitionApproved) return na('EXPENDITURE_ACCOUNTING_DEFINITION_NOT_APPROVED');
  if (e.currency !== r.currency) return na('CURRENCY_MISMATCH');
  try { if (!isPositive(e.amount)) return na('EXPENDITURE_NOT_POSITIVE'); return { available: true, ratio: divide(r.amount, e.amount, 4) }; } catch (err) { if (err instanceof DecimalError) return na('INVALID_AMOUNT'); throw err; }
}

/** Historical OBSERVED customer value only. A prediction is never produced here: it needs an approved model and is reported as unavailable. */
export interface ApprovedValueDefinition { version: string; minimumTransactions: number; includeRefunds: 'net'; approvedByOwner: true }
export function observedCustomerValue(input: { definition: ApprovedValueDefinition | null | undefined; customerRef: string; revenue: readonly RevenueRecord[] }): Available<{ kind: 'historical_observed'; amount: string; currency: string; transactions: number }> | Unavailable {
  const d = input.definition; if (!d || d.approvedByOwner !== true || !Number.isInteger(d.minimumTransactions) || d.minimumTransactions < 1) return na('VALUE_DEFINITION_NOT_APPROVED');
  const mine = input.revenue.filter((r) => r.customerRef === input.customerRef);
  if (mine.some((r) => r.status === 'unverified')) return na('UNVERIFIED_REVENUE_PRESENT');
  const ok = mine.filter((r) => r.status === 'verified'); const cur = new Set(ok.map((r) => r.currency));
  if (ok.length < d.minimumTransactions) return na('INSUFFICIENT_TRANSACTION_HISTORY'); if (cur.size !== 1) return na('MIXED_OR_MISSING_CURRENCY');
  const net = ok.map((r) => (r.refundedAmount ? sub(r.amount, r.refundedAmount) : r.amount));
  return { available: true, kind: 'historical_observed', amount: sum(net), currency: [...cur][0]!, transactions: ok.length };
}
export const predictedCustomerValue = (): Unavailable => na('PREDICTION_MODEL_NOT_APPROVED');
export { formatDecimal, parseDecimal };
