/**
 * Split 08 invoice-benefit calculation, policy PC-BENEFIT/1 (owner decisions 2026-10-23, docs/architecture/builds/OWNER_DECISIONS_2026-10-23.md).
 *
 * PURE and NON-AUTHORIZING. It computes what a benefit WOULD be from caller-supplied invoice evidence under the versioned policy. It reads no
 * database, calls no provider and mutates nothing. Its result is never provider-verified and never authorizes consumption or an invoice
 * adjustment (`consumptionAuthorized` and `providerVerified` are the literal `false`); consumption requires confirmed provider-side application
 * reconciled by the Split 08 saga. Policy rules the owner has not yet specified default conservatively and are listed in the decision record.
 */
export const INVOICE_BENEFIT_POLICY_V1 = Object.freeze({
  version: 'PC-BENEFIT/1',
  /** 1 eligible PC = 1% of the eligible invoice base charge. */
  percentPerCredit: 1,
  /** Maximum benefit per eligible invoice, in percent of the eligible base. */
  maxPercent: 10,
  /** Development default (owner-unspecified): monthly invoices only. */
  eligibleIntervals: ['month'] as const,
  /** Development default (owner-unspecified): whole minor units, rounded DOWN so the stated percentage is never exceeded. */
  rounding: 'floor',
});

export type InvoiceLineCategory = 'recurring_base' | 'tax' | 'one_time' | 'previous_balance' | 'proration' | 'add_on' | 'other';
export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

export interface InvoiceBenefitLine {
  id: string;
  category: InvoiceLineCategory;
  /** Integer minor units before discounts. */
  amountMinor: number;
  /** Integer minor units of provider-attributed discount on THIS line; defaults to 0. */
  discountMinor?: number;
  currency: string;
}

export interface InvoiceBenefitEvidence {
  invoiceId: string;
  /** Business that owns the invoice's subscription. */
  invoiceBusinessId: string;
  currency: string;
  status: InvoiceStatus;
  amountDueMinor: number;
  amountPaidMinor: number;
  interval: 'month' | 'year';
  /** True for a trial or free-plan invoice. */
  trialOrFree: boolean;
  lines: readonly InvoiceBenefitLine[];
}

export interface InvoiceBenefitRequest {
  /** Business that owns the Partner Credits being applied. */
  creditBusinessId: string;
  requestedUnits: number;
  availableUnits: number;
}

export type BenefitDenialReason =
  | 'INVALID_INPUT' | 'CROSS_BUSINESS' | 'INVOICE_NOT_PAID' | 'INTERVAL_NOT_ELIGIBLE' | 'TRIAL_OR_FREE' | 'NO_AMOUNT_DUE' | 'CURRENCY_MISMATCH'
  | 'BASE_LINE_COUNT_UNSUPPORTED' | 'NO_ELIGIBLE_BASE' | 'NO_UNITS';

export type InvoiceBenefitResult =
  | {
      eligible: true;
      policyVersion: string;
      unitsToApply: number;
      /** Units the caller asked for that exceed the 10% cap or the available balance; they are simply not applied. */
      unitsNotApplied: number;
      eligibleBaseMinor: number;
      benefitMinor: number;
      percentApplied: number;
      currency: string;
      consumptionAuthorized: false;
      providerVerified: false;
    }
  | { eligible: false; policyVersion: string; reasons: BenefitDenialReason[]; consumptionAuthorized: false; providerVerified: false };

const isMinor = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isCurrency = (c: unknown): c is string => typeof c === 'string' && /^[a-z]{3}$/.test(c);
const nonEmpty = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;

/** Eligible base: the single recurring base line less its attributed discount; taxes, one-time, previous balance, proration and add-ons never count. */
export function eligibleBaseMinor(lines: readonly InvoiceBenefitLine[]): number | { error: 'INVALID_INPUT' | 'BASE_LINE_COUNT_UNSUPPORTED' } {
  let base: number | null = null;
  for (const l of lines) {
    if (!l || !nonEmpty(l.id) || !isMinor(l.amountMinor) || !isCurrency(l.currency)) return { error: 'INVALID_INPUT' };
    const discount = l.discountMinor ?? 0;
    if (!isMinor(discount) || discount > l.amountMinor) return { error: 'INVALID_INPUT' };
    if (l.category !== 'recurring_base') continue;
    if (base !== null) return { error: 'BASE_LINE_COUNT_UNSUPPORTED' }; // multi-item subscriptions are unsupported (HETA-01D)
    base = l.amountMinor - discount;
  }
  return base === null ? { error: 'BASE_LINE_COUNT_UNSUPPORTED' } : base;
}

export function computeInvoiceBenefit(invoice: InvoiceBenefitEvidence, request: InvoiceBenefitRequest): InvoiceBenefitResult {
  const policy = INVOICE_BENEFIT_POLICY_V1;
  const deny = (...reasons: BenefitDenialReason[]): InvoiceBenefitResult => ({
    eligible: false, policyVersion: policy.version, reasons: [...new Set(reasons)], consumptionAuthorized: false, providerVerified: false,
  });
  if (!invoice || !request || !nonEmpty(invoice.invoiceId) || !nonEmpty(invoice.invoiceBusinessId) || !nonEmpty(request.creditBusinessId) ||
      !isCurrency(invoice.currency) || !isMinor(invoice.amountDueMinor) || !isMinor(invoice.amountPaidMinor) || !Array.isArray(invoice.lines) ||
      !Number.isSafeInteger(request.requestedUnits) || request.requestedUnits < 0 || !Number.isSafeInteger(request.availableUnits) || request.availableUnits < 0 ||
      !['draft', 'open', 'paid', 'void', 'uncollectible'].includes(invoice.status) || (invoice.interval !== 'month' && invoice.interval !== 'year') ||
      typeof invoice.trialOrFree !== 'boolean') return deny('INVALID_INPUT');

  const reasons: BenefitDenialReason[] = [];
  if (invoice.invoiceBusinessId !== request.creditBusinessId) reasons.push('CROSS_BUSINESS');
  if (invoice.status !== 'paid' || invoice.amountPaidMinor < invoice.amountDueMinor) reasons.push('INVOICE_NOT_PAID');
  if (!(policy.eligibleIntervals as readonly string[]).includes(invoice.interval)) reasons.push('INTERVAL_NOT_ELIGIBLE');
  if (invoice.trialOrFree) reasons.push('TRIAL_OR_FREE');
  if (invoice.amountDueMinor === 0) reasons.push('NO_AMOUNT_DUE');
  if (invoice.lines.some(l => l && l.currency !== invoice.currency)) reasons.push('CURRENCY_MISMATCH');
  const base = eligibleBaseMinor(invoice.lines);
  if (typeof base !== 'number') reasons.push(base.error);
  else if (base === 0) reasons.push('NO_ELIGIBLE_BASE');
  const maxUnits = Math.floor(policy.maxPercent / policy.percentPerCredit);
  const unitsToApply = Math.min(request.requestedUnits, request.availableUnits, maxUnits);
  if (unitsToApply === 0) reasons.push('NO_UNITS');
  if (reasons.length > 0 || typeof base !== 'number') return deny(...reasons);

  // BigInt so a very large base cannot lose precision; floor division keeps the benefit at or below units% of the base.
  const benefit = (BigInt(base) * BigInt(unitsToApply) * BigInt(policy.percentPerCredit)) / 100n;
  const benefitMinor = Number(benefit);
  if (!Number.isSafeInteger(benefitMinor)) return deny('INVALID_INPUT');
  return {
    eligible: true, policyVersion: policy.version, unitsToApply, unitsNotApplied: request.requestedUnits - unitsToApply,
    eligibleBaseMinor: base, benefitMinor, percentApplied: unitsToApply * policy.percentPerCredit, currency: invoice.currency,
    consumptionAuthorized: false, providerVerified: false,
  };
}
