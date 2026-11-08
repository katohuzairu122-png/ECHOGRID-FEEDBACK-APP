import { describe, expect, it, vi } from 'vitest';
import { resolveReconciliationPolicy } from './reconciliation-policy.preflight';
import { BenefitReconciliationService } from './benefit-reconciliation.service';

const DEFAULT = {
  requiredAbsences: 2,
  minAbsenceGapMs: 300_000,
  inFlightWindowMs: 120_000,
};

describe('Group 17 inert reconciliation policy preflight', () => {
  it('DEV-95 preserves historical defaults and operator-supplied safe values', () => {
    expect(resolveReconciliationPolicy({})).toEqual(DEFAULT);
    expect(resolveReconciliationPolicy({ requiredAbsences: 3, minAbsenceGapMs: 500_000, inFlightWindowMs: 100_000 }))
      .toEqual({ requiredAbsences: 3, minAbsenceGapMs: 500_000, inFlightWindowMs: 100_000 });
  });

  it.each([0, 1, 2])('DEV-95 preserves the two-complete-absence minimum for %i', (requiredAbsences) => {
    expect(resolveReconciliationPolicy({ requiredAbsences }).requiredAbsences).toBe(2);
  });

  it.each([null, undefined, [], 'invalid', 42])(
    'DEV-95 rejects invalid outer policy %j', (value) => {
      expect(() => resolveReconciliationPolicy(value as never))
        .toThrow('RECONCILIATION_POLICY_INVALID');
    },
  );

  it.each(['requiredAbsences', 'minAbsenceGapMs', 'inFlightWindowMs'] as const)(
    'DEV-96 rejects malformed %s before DB/provider work', async (key) => {
      for (const invalid of [NaN, Infinity, -Infinity, -1, 1.5, '2', false, null, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => resolveReconciliationPolicy({ [key]: invalid } as never))
          .toThrow('RECONCILIATION_POLICY_INVALID');
      }
      const transaction = vi.fn();
      const reader = {
        currentAccount: vi.fn(),
        retrieveInvoice: vi.fn(),
        listInvoiceLines: vi.fn(),
      };
      const service = new BenefitReconciliationService({ transaction } as never, {} as never);
      await expect(service.reconcile('some-intent', {
        reader: reader as never,
        scope: { accountId: 'acct_a', livemode: false, customerId: 'cus_a', subscriptionId: 'sub_a' },
        [key]: Number.NaN,
      })).rejects.toThrow('RECONCILIATION_POLICY_INVALID');
      expect(transaction).not.toHaveBeenCalled();
      expect(reader.currentAccount).not.toHaveBeenCalled();
    },
  );

  it('DEV-97 accepts safe zero separation without reducing the required observation count', () => {
    expect(resolveReconciliationPolicy({ minAbsenceGapMs: 0, inFlightWindowMs: 0 }))
      .toEqual({ ...DEFAULT, minAbsenceGapMs: 0, inFlightWindowMs: 0 });
  });
});
