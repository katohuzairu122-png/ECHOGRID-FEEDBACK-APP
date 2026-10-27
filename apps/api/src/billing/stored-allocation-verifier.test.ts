import { describe, expect, it } from 'vitest';
import { freezeAggregateBenefitAllocation, AGGREGATE_ALLOCATION_POLICY, type AggregateAllocationInput } from './aggregate-benefit-allocation';
import { verifyStoredAllocationSnapshot } from './stored-allocation-verifier';
import { computeInvoiceBenefit } from './invoice-benefit.calculator';

const businessId = '11111111-1111-4111-8111-111111111111';
const input = (): AggregateAllocationInput => {
  const benefit = computeInvoiceBenefit({
    invoiceId: 'in_fixture', invoiceBusinessId: businessId, currency: 'usd',
    status: 'paid', amountDueMinor: 199, amountPaidMinor: 199,
    interval: 'month', trialOrFree: false,
    lines: [{ id: 'il_fixture', category: 'recurring_base', amountMinor: 199, currency: 'usd' }],
  }, { creditBusinessId: businessId, requestedUnits: 2, availableUnits: 2 });
  if (!benefit.eligible) throw new Error('Fixture calculator rejected input');
  return {
    allocationPolicyVersion: AGGREGATE_ALLOCATION_POLICY,
    invoice: { businessId, invoiceRef: 'in_fixture', currency: 'usd' },
    benefit, eligibleCreditBalance: 2,
    reservations: [1, 2].map(n => ({
      id: `00000000-0000-4000-8000-00000000000${n}`,
      businessId, invoiceIntentRef: `intent_${n}`, invoiceRef: 'in_fixture',
      currency: 'usd', units: 1 as const, state: 'reserved' as const,
      providerAttemptStarted: false as const,
    })),
  };
};

describe('S08-DEV-05 stored artifact verification', () => {
  it('rejects absent or malformed stored objects', async () => {
    expect((await verifyStoredAllocationSnapshot(null, input())).status).toBe('rejected');
    expect((await verifyStoredAllocationSnapshot({ allocationDigest: 'foo' }, input())).status).toBe('rejected');
  });
  it('recomputes and checks the entire stored snapshot', async () => {
    const evidence = input();
    const stored = await freezeAggregateBenefitAllocation(evidence);
    const result = await verifyStoredAllocationSnapshot(JSON.parse(JSON.stringify(stored)), evidence);
    expect(result.status).toBe('verified_snapshot');
    expect(result.providerVerified).toBe(false);
    expect(result.consumptionAuthorized).toBe(false);
  });
  it('rejects tampered allocation with unchanged digest', async () => {
    const evidence = input();
    const stored = await freezeAggregateBenefitAllocation(evidence);
    const forged = JSON.parse(JSON.stringify(stored));
    forged.allocations[0].benefitMinor += 1;
    expect((await verifyStoredAllocationSnapshot(forged, evidence)).status).toBe('rejected');
  });
  it('rejects a different invoice even if the saved artifact remains unchanged', async () => {
    const evidence = input();
    const stored = await freezeAggregateBenefitAllocation(evidence);
    const different = { ...evidence, invoice: { ...evidence.invoice, invoiceRef: 'in_other' } };
    expect((await verifyStoredAllocationSnapshot(stored, different)).status).toBe('rejected');
  });
});
