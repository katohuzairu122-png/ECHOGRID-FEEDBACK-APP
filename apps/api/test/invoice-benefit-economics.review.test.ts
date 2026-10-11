import { describe, expect, it } from 'vitest';
import {
  inspectInvoiceBenefitEconomics, inspectProviderBenefitEvidence,
  type InvoiceBenefitEconomicsCandidate,
  type InvoiceBenefitProviderEvidenceCandidate,
} from '../src/billing/invoice-benefit-economics.review';

const policy: InvoiceBenefitEconomicsCandidate = {
  policyVersion:'TEST-NOT-APPROVED',
  decisionRecordRef:'synthetic-test-only',
  approvedByBillingAuthority:'synthetic-test-only',
  effectiveAt:'2026-10-11T00:00:00Z',
  creditUnitBenefitMinor:100,currency:'usd',
  eligibleBillingIntervals:['month'],
  eligibleInvoiceBase:'pre_tax_recurring',
  taxTreatment:'pre_tax_discount',
  prorationTreatment:'exclude',trialTreatment:'exclude',
  refundTreatment:'retain_historical_application',
  currencyMismatchTreatment:'reject',
  maxBenefitTreatment:'cap_at_eligible_amount',
};
const evidence: InvoiceBenefitProviderEvidenceCandidate = {
  applicationRef:'fake-application',reservationRef:'fake-reservation',
  businessId:'fake-business',invoiceRef:'in_test',
  stripeCustomerRef:'cus_test',stripeSubscriptionRef:'sub_test',
  providerLineOrAdjustmentRef:'il_test',policyVersion:'TEST-NOT-APPROVED',
  benefitMinor:100,currency:'usd',
  providerInvoiceState:'paid',providerAdjustmentState:'applied',
};

describe('Split 08 benefit economics review (non-authorizing)', () => {
  it('enumerates the unresolved policy choices for an empty candidate', () => {
    const result=inspectInvoiceBenefitEconomics({});
    expect(result.readyForArchitectureReview).toBe(false);
    expect(result.unresolved).toContain('UNIT_BENEFIT_MINOR');
    expect(result.unresolved).toContain('TAX_TREATMENT');
    expect(result.unresolved).toContain('REFUND_TREATMENT');
    expect(result.economicAuthorityGranted).toBe(false);
  });
  it('never equates a complete but synthetic policy object with approval', () => {
    expect(inspectInvoiceBenefitEconomics(policy)).toEqual({
      readyForArchitectureReview:true,unresolved:[],economicAuthorityGranted:false,
    });
  });
  it('rejects malformed money amount, duplicate billing interval and currency', () => {
    const result=inspectInvoiceBenefitEconomics({
      ...policy,creditUnitBenefitMinor:1.5,currency:'USD',
      eligibleBillingIntervals:['month','month'],
    });
    expect(result.unresolved).toEqual(expect.arrayContaining([
      'UNIT_BENEFIT_MINOR','CURRENCY','BILLING_INTERVAL',
    ]));
    expect(result.economicAuthorityGranted).toBe(false);
  });
  it('does not treat a well-formed provider claim as independently reconciled', () => {
    expect(inspectProviderBenefitEvidence(evidence)).toEqual({
      structurallyComplete:true,reasons:[],providerReconciled:false,
    });
  });
  it('flags missing attribution and a nonterminal invoice', () => {
    const result=inspectProviderBenefitEvidence({
      ...evidence,providerLineOrAdjustmentRef:'',providerInvoiceState:'open',
      benefitMinor:0,stripeSubscriptionRef:'foreign',
    });
    expect(result.reasons).toEqual(expect.arrayContaining([
      'providerLineOrAdjustmentRef','providerInvoiceState',
      'benefitMinor','stripeSubscriptionRef',
    ]));
    expect(result.providerReconciled).toBe(false);
  });
});
