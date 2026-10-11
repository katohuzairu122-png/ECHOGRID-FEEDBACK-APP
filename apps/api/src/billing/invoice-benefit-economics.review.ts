/**
 * Split 08 invoice-benefit economics: architecture review utility, NOT a
 * policy engine, money calculation or authority to post an adjustment.
 * All monetary and tax decisions require a separately frozen Split 08 policy.
 */
export interface InvoiceBenefitEconomicsCandidate {
  policyVersion?: string;
  decisionRecordRef?: string;
  approvedByBillingAuthority?: string;
  effectiveAt?: string;
  creditUnitBenefitMinor?: number;
  currency?: string;
  eligibleBillingIntervals?: readonly ('month' | 'year')[];
  eligibleInvoiceBase?: 'pre_tax_recurring' | 'post_tax_total';
  taxTreatment?: 'pre_tax_discount' | 'post_tax_credit';
  prorationTreatment?: 'exclude' | 'apply';
  trialTreatment?: 'exclude' | 'apply';
  refundTreatment?: 'retain_historical_application' | 'reverse_provider_adjustment';
  currencyMismatchTreatment?: 'reject' | 'convert';
  maxBenefitTreatment?: 'cap_at_eligible_amount' | 'reject';
}

export function inspectInvoiceBenefitEconomics(
  candidate: InvoiceBenefitEconomicsCandidate,
): { readyForArchitectureReview: boolean; unresolved: string[]; economicAuthorityGranted: false } {
  const unresolved: string[] = [];
  if (!candidate.policyVersion?.trim()) unresolved.push('POLICY_VERSION');
  if (!candidate.decisionRecordRef?.trim()) unresolved.push('SIGNED_DECISION_REFERENCE');
  if (!candidate.approvedByBillingAuthority?.trim()) unresolved.push('BILLING_AUTHORITY_APPROVAL');
  if (!candidate.effectiveAt || !Number.isFinite(Date.parse(candidate.effectiveAt)))
    unresolved.push('EFFECTIVE_TIMESTAMP');
  if (!Number.isSafeInteger(candidate.creditUnitBenefitMinor) ||
      (candidate.creditUnitBenefitMinor ?? 0) <= 0)
    unresolved.push('UNIT_BENEFIT_MINOR');
  if (!candidate.currency || !/^[a-z]{3}$/.test(candidate.currency))
    unresolved.push('CURRENCY');
  if (!candidate.eligibleBillingIntervals?.length ||
      candidate.eligibleBillingIntervals.some(x => x !== 'month' && x !== 'year') ||
      new Set(candidate.eligibleBillingIntervals).size !== candidate.eligibleBillingIntervals.length)
    unresolved.push('BILLING_INTERVAL');
  if (!['pre_tax_recurring','post_tax_total'].includes(candidate.eligibleInvoiceBase ?? ''))
    unresolved.push('INVOICE_BASE');
  if (!['pre_tax_discount','post_tax_credit'].includes(candidate.taxTreatment ?? ''))
    unresolved.push('TAX_TREATMENT');
  if (!['exclude','apply'].includes(candidate.prorationTreatment ?? ''))
    unresolved.push('PRORATION_TREATMENT');
  if (!['exclude','apply'].includes(candidate.trialTreatment ?? ''))
    unresolved.push('TRIAL_TREATMENT');
  if (!['retain_historical_application','reverse_provider_adjustment'].includes(candidate.refundTreatment ?? ''))
    unresolved.push('REFUND_TREATMENT');
  if (!['reject','convert'].includes(candidate.currencyMismatchTreatment ?? ''))
    unresolved.push('CURRENCY_MISMATCH');
  if (!['cap_at_eligible_amount','reject'].includes(candidate.maxBenefitTreatment ?? ''))
    unresolved.push('BENEFIT_CAP');
  return {
    readyForArchitectureReview: unresolved.length === 0,
    unresolved,
    // Even an apparently complete JSON cannot prove a signed policy,
    // authorized approver, or provider's actual invoice adjustment.
    economicAuthorityGranted:false,
  };
}

export interface InvoiceBenefitProviderEvidenceCandidate {
  applicationRef: string;
  reservationRef: string;
  businessId: string;
  invoiceRef: string;
  stripeCustomerRef: string;
  stripeSubscriptionRef: string;
  providerLineOrAdjustmentRef: string;
  policyVersion: string;
  benefitMinor: number;
  currency: string;
  providerInvoiceState: string;
  providerAdjustmentState: string;
}

/** Static evidence completeness review. NEVER promotes a caller's assertion
 * into trusted Stripe benefit evidence; no verified provider adapter exists.
 */
export function inspectProviderBenefitEvidence(
  evidence: InvoiceBenefitProviderEvidenceCandidate,
): { structurallyComplete: boolean; reasons: string[]; providerReconciled: false } {
  const reasons: string[] = [];
  const strings = [
    'applicationRef','reservationRef','businessId','policyVersion',
    'providerLineOrAdjustmentRef',
  ] as const;
  for (const key of strings) if (!evidence[key]?.trim()) reasons.push(key);
  if (!evidence.invoiceRef.startsWith('in_')) reasons.push('invoiceRef');
  if (!evidence.stripeCustomerRef.startsWith('cus_')) reasons.push('stripeCustomerRef');
  if (!evidence.stripeSubscriptionRef.startsWith('sub_')) reasons.push('stripeSubscriptionRef');
  if (!Number.isSafeInteger(evidence.benefitMinor) || evidence.benefitMinor <= 0)
    reasons.push('benefitMinor');
  if (!/^[a-z]{3}$/.test(evidence.currency)) reasons.push('currency');
  if (evidence.providerInvoiceState !== 'paid') reasons.push('providerInvoiceState');
  if (evidence.providerAdjustmentState !== 'applied') reasons.push('providerAdjustmentState');
  return { structurallyComplete:reasons.length === 0, reasons, providerReconciled:false };
}
