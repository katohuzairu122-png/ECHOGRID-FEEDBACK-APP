import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { computeInvoiceBenefit } from './invoice-benefit.calculator';
import {
  AGGREGATE_ALLOCATION_POLICY, AggregateAllocationError, freezeAggregateBenefitAllocation,
  type AggregateAllocationInput, type AllocationRejectCode, type FrozenAggregateBenefitAllocation,
} from './aggregate-benefit-allocation';

const businessId = '11111111-1111-4111-8111-111111111111';
const otherBusiness = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

function fixture(count = 2, base = 199): AggregateAllocationInput {
  const benefit = computeInvoiceBenefit({
    invoiceId: 'in_fixture', invoiceBusinessId: businessId, currency: 'usd', status: 'paid',
    amountDueMinor: base, amountPaidMinor: base, interval: 'month', trialOrFree: false,
    lines: [{ id: 'li_base', category: 'recurring_base', amountMinor: base, currency: 'usd' }],
  }, { creditBusinessId: businessId, requestedUnits: count, availableUnits: count });
  if (!benefit.eligible) throw new Error('bad fixture');
  return {
    allocationPolicyVersion: AGGREGATE_ALLOCATION_POLICY,
    invoice: { businessId, invoiceRef: 'in_fixture', currency: 'usd' },
    benefit, eligibleCreditBalance: count,
    reservations: Array.from({ length: count }, (_, i) => ({
      id: id(i + 1), businessId, invoiceIntentRef: `intent_${i + 1}`, invoiceRef: 'in_fixture',
      currency: 'usd', units: 1 as const, state: 'reserved' as const, providerAttemptStarted: false as const,
    })),
  };
}

async function denied(input: unknown, code: AllocationRejectCode) {
  await expect(freezeAggregateBenefitAllocation(input as AggregateAllocationInput)).rejects.toMatchObject({
    name: 'AggregateAllocationError', code, providerVerified: false, consumptionAuthorized: false,
  });
}
const amounts = (a: FrozenAggregateBenefitAllocation) => a.allocations.map(x => x.benefitMinor);

describe('S08-DEV-04 deterministic aggregate allocation', () => {
  it('allocates a single credit and preserves its stable provider key', async () => {
    const r = await freezeAggregateBenefitAllocation(fixture(1, 10_000));
    expect(amounts(r)).toEqual([100]);
    expect(r.allocations[0]).toMatchObject({ reservationId: id(1), units: 1, providerIdempotencyKey: `benefit-apply:v1:${id(1)}` });
  });

  it('rounds 199 x 2 / 100 once and allocates 2 + 1 to ascending IDs', async () => {
    const r = await freezeAggregateBenefitAllocation(fixture());
    expect(r.aggregateBenefitMinor).toBe(3);
    expect(amounts(r)).toEqual([2, 1]);
    expect(r.allocations.map(x => x.reservationId)).toEqual([id(1), id(2)]);
  });

  it('supports the ten-credit maximum and conserves the 10% benefit', async () => {
    const r = await freezeAggregateBenefitAllocation(fixture(10, 10_099));
    expect(r.unitsToApply).toBe(10);
    expect(r.percentApplied).toBe(10);
    expect(r.aggregateBenefitMinor).toBe(1009);
    expect(amounts(r)).toEqual([...Array<number>(9).fill(101), 100]);
  });

  it('rejects more than ten identities instead of silently truncating', async () => {
    await denied(fixture(11), 'CREDIT_LIMIT');
  });

  it.each([1, 50, 99])('rejects the whole two-credit batch when base %i yields zero shares', async base => {
    await denied(fixture(2, base), 'ZERO_ALLOCATION');
  });

  it('accepts the smallest all-positive two-credit allocation', async () => {
    expect(amounts(await freezeAggregateBenefitAllocation(fixture(2, 100)))).toEqual([1, 1]);
  });

  it('rejects duplicate reservation identities', async () => {
    const f = fixture();
    await denied({ ...f, reservations: [f.reservations[0], { ...f.reservations[1], id: id(1) }] }, 'DUPLICATE_RESERVATION');
  });

  it('preserves the existing distinct business/invoice-intent reservation key', async () => {
    const f = fixture();
    await denied({ ...f, reservations: [f.reservations[0], { ...f.reservations[1], invoiceIntentRef: 'intent_1' }] }, 'DUPLICATE_INVOICE_INTENT');
  });

  it.each(['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-00000000000A', ' ' + id(1)])('rejects invalid/noncanonical reservation ID %s', async invalid => {
    const f = fixture(1);
    await denied({ ...f, reservations: [{ ...f.reservations[0], id: invalid }] }, 'INVALID_IDENTITY');
  });

  it('rejects missing reservation identity fields', async () => {
    const f = fixture(1);
    for (const key of ['id', 'businessId', 'invoiceIntentRef', 'invoiceRef', 'currency']) {
      const r = { ...f.reservations[0] };
      Reflect.deleteProperty(r, key);
      await denied({ ...f, reservations: [r] }, 'INVALID_IDENTITY');
    }
  });

  it('rejects cross-business reservation substitution', async () => {
    const f = fixture(1);
    await denied({ ...f, reservations: [{ ...f.reservations[0], businessId: otherBusiness }] }, 'CROSS_BUSINESS');
  });

  it('rejects an invalid invoice business identity', async () => {
    const f = fixture();
    await denied({ ...f, invoice: { ...f.invoice, businessId: '' } }, 'INVALID_IDENTITY');
  });

  it('rejects cross-invoice substitution', async () => {
    const f = fixture(1);
    await denied({ ...f, reservations: [{ ...f.reservations[0], invoiceRef: 'in_other' }] }, 'INVOICE_MISMATCH');
  });

  it.each(['', 'in_', ' in_fixture', 'in_fixture other'])('rejects invalid invoice reference %s', async invoiceRef => {
    const f = fixture();
    await denied({ ...f, invoice: { ...f.invoice, invoiceRef } }, 'INVALID_IDENTITY');
  });

  it('rejects calculator or reservation currency mismatches', async () => {
    const f = fixture(1);
    await denied({ ...f, benefit: { ...f.benefit, currency: 'eur' } }, 'CURRENCY_MISMATCH');
    await denied({ ...f, reservations: [{ ...f.reservations[0], currency: 'eur' }] }, 'CURRENCY_MISMATCH');
    await denied({ ...f, invoice: { ...f.invoice, currency: 'USD' } }, 'INVALID_INPUT');
  });

  it('rejects unsupported calculator and allocation policy versions', async () => {
    const f = fixture();
    await denied({ ...f, allocationPolicyVersion: 'S08-AGG-ROUND/2' }, 'UNSUPPORTED_POLICY');
    await denied({ ...f, benefit: { ...f.benefit, policyVersion: 'PC-ECON/2' } }, 'UNSUPPORTED_POLICY');
  });

  it('is independent of input order for all permutations of four reservations', async () => {
    const f = fixture(4, 199);
    const baseline = await freezeAggregateBenefitAllocation(f);
    const permute = <T,>(xs: readonly T[]): T[][] => xs.length === 0 ? [[]] : xs.flatMap((x, i) => permute(xs.filter((_, j) => i !== j)).map(rest => [x, ...rest]));
    const permutations = permute(f.reservations);
    expect(permutations).toHaveLength(24);
    for (const reservations of permutations) expect(await freezeAggregateBenefitAllocation({ ...f, reservations })).toEqual(baseline);
  });

  it('orders canonical UUIDs by byte-equivalent code units, not incoming order', async () => {
    const f = fixture(3, 199);
    const ids = [id(16), id(2), id(10)];
    const r = await freezeAggregateBenefitAllocation({ ...f, reservations: f.reservations.map((x, i) => ({ ...x, id: ids[i]! })) });
    expect(r.allocations.map(x => x.reservationId)).toEqual([id(2), id(10), id(16)]);
    expect(amounts(r)).toEqual([2, 2, 1]);
  });

  it('repeats the same allocation and digest without clock or random input', async () => {
    const f = fixture();
    const first = await freezeAggregateBenefitAllocation(f);
    for (let i = 0; i < 10; i++) expect(await freezeAggregateBenefitAllocation(structuredClone(f))).toEqual(first);
  });

  it('conserves amounts and limits over 600 deterministic generated cases', async () => {
    let seed = 149;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let i = 0; i < 600; i++) {
      const n = next() % 10 + 1;
      const base = next() % 10_000_000 + 100;
      const f = fixture(n, base);
      const r = await freezeAggregateBenefitAllocation({ ...f, reservations: [...f.reservations].reverse() });
      const values = amounts(r).map(BigInt);
      const sum = values.reduce((a, b) => a + b, 0n);
      const independentTotal = BigInt(base) * BigInt(n) / 100n;
      expect(sum).toBe(independentTotal);
      expect(r.aggregateBenefitMinor).toBe(f.benefit.benefitMinor);
      expect(values.every(v => v > 0n)).toBe(true);
      expect(sum * 100n <= BigInt(base) * 10n).toBe(true);
      expect(r.allocations.map(a => a.reservationId)).toEqual(f.reservations.map(a => a.id).sort());
      expect(new Set(r.allocations.map(a => a.reservationId)).size).toBe(n);
      // Mathematical characterization of equal shares plus ordered residuals.
      expect(values[0]! - values[values.length - 1]!).toBeLessThanOrEqual(1n);
      expect(values.every((v, j) => j === 0 || values[j - 1]! >= v)).toBe(true);
    }
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN, 0.5])('rejects unsafe/noninteger amount %s', async value => {
    const f = fixture();
    await denied({ ...f, benefit: { ...f.benefit, eligibleBaseMinor: value } }, 'INVALID_INPUT');
    await denied({ ...f, benefit: { ...f.benefit, benefitMinor: value } }, 'INVALID_INPUT');
  });

  it('handles MAX_SAFE_INTEGER base without overflowing the intermediate multiplication', async () => {
    const f = fixture(10, Number.MAX_SAFE_INTEGER);
    const r = await freezeAggregateBenefitAllocation(f);
    const sum = r.allocations.reduce((n, a) => n + BigInt(a.benefitMinor), 0n);
    expect(sum).toBe(BigInt(Number.MAX_SAFE_INTEGER) * 10n / 100n);
    expect(r.aggregateBenefitMinor).toBe(f.benefit.benefitMinor);
    expect(r.allocations.every(a => Number.isSafeInteger(a.benefitMinor))).toBe(true);
  });

  it('rejects negative base, aggregate, balance and calculator counters', async () => {
    const f = fixture();
    for (const field of ['eligibleBaseMinor', 'benefitMinor', 'unitsToApply', 'unitsNotApplied', 'percentApplied'])
      await denied({ ...f, benefit: { ...f.benefit, [field]: -1 } }, 'INVALID_INPUT');
    await denied({ ...f, eligibleCreditBalance: -1 }, 'INVALID_INPUT');
  });

  it('rejects empty reservation sets', async () => {
    await denied({ ...fixture(), reservations: [] }, 'CREDIT_LIMIT');
  });

  it('deep-freezes the output and detaches it from later input mutations', async () => {
    const f = fixture();
    const r = await freezeAggregateBenefitAllocation(f);
    const before = JSON.stringify(r);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.allocations)).toBe(true);
    expect(r.allocations.every(Object.isFrozen)).toBe(true);
    expect(Reflect.set(r, 'aggregateBenefitMinor', 999)).toBe(false);
    expect(Reflect.set(r.allocations, '0', {})).toBe(false);
    expect(Reflect.set(r.allocations[0]!, 'benefitMinor', 999)).toBe(false);
    Reflect.set(f.benefit, 'benefitMinor', 999);
    Reflect.set(f.invoice, 'invoiceRef', 'in_changed');
    Reflect.set(f.reservations[0]!, 'id', id(999));
    expect(JSON.stringify(r)).toBe(before);
  });

  it('snapshots synchronously before hashing so caller changes during the await cannot alter the artifact', async () => {
    const f = fixture();
    const pending = freezeAggregateBenefitAllocation(f);
    Reflect.set(f.benefit, 'benefitMinor', 999);
    Reflect.set(f.reservations[0]!, 'invoiceIntentRef', 'changed');
    const r = await pending;
    expect(r).toEqual(await freezeAggregateBenefitAllocation(fixture()));
  });

  it('supports frozen caller input without modifying it', async () => {
    const f = fixture();
    Object.freeze(f.invoice); Object.freeze(f.benefit);
    f.reservations.forEach(Object.freeze); Object.freeze(f.reservations); Object.freeze(f);
    expect(amounts(await freezeAggregateBenefitAllocation(f))).toEqual([2, 1]);
  });

  it('matches an independently encoded versioned SHA-256 tuple', async () => {
    const r = await freezeAggregateBenefitAllocation(fixture());
    const independentTuple = [
      'ECHO-GRID:S08-AGG-ROUND:artifact/1', 'S08-AGG-ROUND/1', 'PC-BENEFIT/1',
      businessId, 'in_fixture', 'usd', 199, 2, 2, 3, 2, false, false,
      [[id(1), 'intent_1', 1, 2, `benefit-apply:v1:${id(1)}`], [id(2), 'intent_2', 1, 1, `benefit-apply:v1:${id(2)}`]],
    ];
    expect(r.allocationDigest).toBe(createHash('sha256').update(JSON.stringify(independentTuple), 'utf8').digest('hex'));
    expect(r.allocationDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds tenant, invoice, currency, capacity, base, intent and reservation identity into the digest', async () => {
    const f = fixture();
    const original = (await freezeAggregateBenefitAllocation(f)).allocationDigest;
    const variants: AggregateAllocationInput[] = [
      { ...f, invoice: { ...f.invoice, businessId: otherBusiness }, reservations: f.reservations.map(x => ({ ...x, businessId: otherBusiness })) },
      { ...f, invoice: { ...f.invoice, invoiceRef: 'in_other' }, reservations: f.reservations.map(x => ({ ...x, invoiceRef: 'in_other' })) },
      { ...f, invoice: { ...f.invoice, currency: 'eur' }, benefit: { ...f.benefit, currency: 'eur' }, reservations: f.reservations.map(x => ({ ...x, currency: 'eur' })) },
      { ...f, eligibleCreditBalance: 3 },
      fixture(2, 198), // same aggregate and shares, different source base
      { ...f, reservations: f.reservations.map(x => ({ ...x, invoiceIntentRef: x.invoiceIntentRef + '_v2' })) },
      { ...f, reservations: f.reservations.map((x, i) => ({ ...x, id: id(i + 3) })) },
    ];
    for (const v of variants) expect((await freezeAggregateBenefitAllocation(v)).allocationDigest).not.toBe(original);
  });

  it('rejects fabricated aggregate or percentage above the approved cap', async () => {
    const f = fixture(10, 10_000);
    await denied({ ...f, benefit: { ...f.benefit, benefitMinor: 1001 } }, 'AGGREGATE_MISMATCH');
    await denied({ ...f, benefit: { ...f.benefit, percentApplied: 11 } }, 'AGGREGATE_MISMATCH');
    await denied({ ...f, benefit: { ...f.benefit, unitsToApply: 11 } }, 'AGGREGATE_MISMATCH');
  });

  it('preserves existing calculator totals for every supported credit count', async () => {
    for (const base of [100, 199, 9999, 10_000, Number.MAX_SAFE_INTEGER]) {
      for (let count = 1; count <= 10; count++) {
        const f = fixture(count, base);
        const r = await freezeAggregateBenefitAllocation(f);
        expect(r.aggregateBenefitMinor).toBe(f.benefit.benefitMinor);
        expect(r.percentApplied).toBe(f.benefit.percentApplied);
      }
    }
  });

  it('rejects insufficient or malformed eligible balances', async () => {
    const f = fixture();
    await denied({ ...f, eligibleCreditBalance: 1 }, 'INSUFFICIENT_ELIGIBLE_CREDITS');
    for (const value of [Number.MAX_SAFE_INTEGER + 1, Number.NaN, 0.5])
      await denied({ ...f, eligibleCreditBalance: value }, 'INVALID_INPUT');
  });

  it('rejects non-one-unit or terminal reservations before any artifact is produced', async () => {
    const f = fixture(1);
    for (const change of [{ units: 2 }, { units: 0 }, { state: 'released' }, { state: 'consumed' }])
      await denied({ ...f, reservations: [{ ...f.reservations[0], ...change }] }, 'RESERVATION_NOT_ELIGIBLE');
  });

  it('refuses allocation after an attempted provider operation or missing pre-attempt evidence', async () => {
    const f = fixture(1);
    for (const providerAttemptStarted of [true, undefined])
      await denied({ ...f, reservations: [{ ...f.reservations[0], providerAttemptStarted }] }, 'PROVIDER_ATTEMPT_STARTED');
  });

  it('rejects malformed shapes and ineligible or authorizing calculator claims', async () => {
    for (const bad of [null, undefined, {}, { ...fixture(), invoice: null }, { ...fixture(), reservations: null }, { ...fixture(), reservations: [null, null] }])
      await denied(bad, bad && 'reservations' in bad && Array.isArray(bad.reservations) ? 'INVALID_IDENTITY' : 'INVALID_INPUT');
    const f = fixture();
    for (const change of [{ eligible: false }, { providerVerified: true }, { consumptionAuthorized: true }])
      await denied({ ...f, benefit: { ...f.benefit, ...change } }, 'INVALID_INPUT');
  });

  it('does not call a provider or mutate any input and always denies financial authority', async () => {
    const fetch = vi.fn(() => { throw new Error('network must not be used'); });
    vi.stubGlobal('fetch', fetch);
    try {
      const f = fixture();
      const before = structuredClone(f);
      const r = await freezeAggregateBenefitAllocation(f);
      expect(f).toEqual(before);
      expect(fetch).not.toHaveBeenCalled();
      expect(r.providerVerified).toBe(false);
      expect(r.consumptionAuthorized).toBe(false);
      const error = new AggregateAllocationError('INVALID_INPUT');
      expect(error.providerVerified).toBe(false);
      expect(error.consumptionAuthorized).toBe(false);
      // Audit the dependency boundary as well as behavior: only the existing pure calculator is imported.
      const text = readFileSync(new URL('./aggregate-benefit-allocation.ts', import.meta.url), 'utf8');
      const imports = [...text.matchAll(/from ['"]([^'"]+)['"]/g)].map(m => m[1]);
      expect(imports).toEqual(['./invoice-benefit.calculator']);
    } finally { vi.unstubAllGlobals(); }
  });
});
