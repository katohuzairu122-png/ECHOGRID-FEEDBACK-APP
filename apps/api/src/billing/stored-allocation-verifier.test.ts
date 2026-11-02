import { describe, expect, it } from 'vitest';
import { freezeAggregateBenefitAllocation, AGGREGATE_ALLOCATION_POLICY, type AggregateAllocationInput } from './aggregate-benefit-allocation';
import { verifyStoredAllocationSnapshot, verifyStoredAllocationEvidence, type StoredAllocationParent, type StoredAllocationItem } from './stored-allocation-verifier';
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
  const persisted = async () => {
    const source = input();
    const artifact = await freezeAggregateBenefitAllocation(source);
    const parent: StoredAllocationParent = {
      id: '33333333-3333-4333-8333-333333333333', business_id: artifact.businessId,
      invoice_ref: artifact.invoiceRef, currency: artifact.currency,
      policy_version: artifact.allocationPolicyVersion, allocation_digest: artifact.allocationDigest,
      aggregate_benefit_minor: String(artifact.aggregateBenefitMinor), reservation_count: 2,
      provider_verified: false, consumption_authorized: false, artifact,
    };
    const items: StoredAllocationItem[] = artifact.allocations.map(a => ({
      freeze_id: parent.id, business_id: parent.business_id, reservation_id: a.reservationId,
      invoice_intent_ref: a.invoiceIntentRef, benefit_minor: String(a.benefitMinor),
      provider_idempotency_key: a.providerIdempotencyKey,
    }));
    return { parent, items, source };
  };
  it('checks the full relational envelope with and without an independent source', async () => {
    const { parent, items, source } = await persisted();
    for (const result of [await verifyStoredAllocationEvidence(parent, items, source), await verifyStoredAllocationEvidence(parent, items)]) {
      expect(result.status).toBe('verified_snapshot');
      expect(result.providerVerified).toBe(false);
      expect(result.consumptionAuthorized).toBe(false);
    }
  });
  it.each([
    ['currency', 'eur'], ['aggregate_benefit_minor', '999'], ['aggregate_benefit_minor', 'bad'],
    ['business_id', '22222222-2222-4222-8222-222222222222'], ['invoice_ref', 'in_other'],
    ['policy_version', 'unsupported'], ['allocation_digest', 'a'.repeat(64)],
    ['reservation_count', 1], ['provider_verified', true], ['consumption_authorized', true],
    ['artifact', null],
  ])('rejects inconsistent persisted parent %s=%s', async (key, value) => {
    const { parent, items, source } = await persisted();
    const altered = { ...parent, [key]: value };
    expect((await verifyStoredAllocationEvidence(altered, items, source)).status).toBe('rejected');
    expect((await verifyStoredAllocationEvidence(altered, items)).status).toBe('rejected');
  });
  it.each([
    ['freeze_id', '44444444-4444-4444-8444-444444444444'],
    ['business_id', '22222222-2222-4222-8222-222222222222'],
    ['reservation_id', '00000000-0000-4000-8000-000000000009'],
    ['invoice_intent_ref', 'other'], ['benefit_minor', '999'],
    ['provider_idempotency_key', 'other'],
  ])('rejects inconsistent persisted child %s', async (key, value) => {
    const { parent, items } = await persisted();
    items[0] = { ...items[0]!, [key]: value };
    expect((await verifyStoredAllocationEvidence(parent, items)).status).toBe('rejected');
  });
  it('rejects missing, duplicate and reordered child evidence', async () => {
    const { parent, items } = await persisted();
    for (const altered of [items.slice(1), [...items, items[0]!], [...items].reverse()]) {
      expect((await verifyStoredAllocationEvidence(parent, altered)).status).toBe('rejected');
    }
  });
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
