import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { computeInvoiceBenefit } from './invoice-benefit.calculator';
import { AGGREGATE_ALLOCATION_POLICY } from './aggregate-benefit-allocation';
import { freezeAllocationTransaction } from './allocation-freeze.transaction';

const businessId = '11111111-1111-4111-8111-111111111111';
const reservationId = '00000000-0000-4000-8000-000000000001';
const input = () => {
  const benefit = computeInvoiceBenefit({
    invoiceId: 'in_fixture', invoiceBusinessId: businessId, currency: 'usd',
    status: 'paid', amountDueMinor: 199, amountPaidMinor: 199, interval: 'month', trialOrFree: false,
    lines: [{ id: 'li_1', category: 'recurring_base' as const, amountMinor: 199, currency: 'usd' }],
  }, { creditBusinessId: businessId, requestedUnits: 1, availableUnits: 1 });
  if (!benefit.eligible) throw new Error('bad test fixture');
  return {
    allocationPolicyVersion: AGGREGATE_ALLOCATION_POLICY,
    invoice: { businessId, invoiceRef: 'in_fixture', currency: 'usd' },
    benefit, eligibleCreditBalance: 1,
    reservations: [{
      id: reservationId, businessId, invoiceIntentRef: 'intent_1', invoiceRef: 'in_fixture',
      currency: 'usd', units: 1 as const, state: 'reserved' as const,
      providerAttemptStarted: false as const,
    }],
  };
};

describe('S08-DEV-06 fail-closed transactional writer', () => {
  it('rolls back when the database inert guard refuses persistence', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM partner_credit_reservations')) return {
          rows: [{ id: reservationId, business_id: businessId, invoice_intent_ref: 'intent_1', state: 'reserved', units: 1, expires: false }],
        };
        if (sql.includes('INSERT INTO s08_allocation_freezes')) throw new Error('S08_ALLOCATION_INERT');
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as PoolClient;
    await expect(freezeAllocationTransaction(client, input())).rejects.toThrow('S08_ALLOCATION_INERT');
    expect(queries[0]).toBe('BEGIN');
    expect(queries.at(-1)).toBe('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
  });
  it('refuses a reservation that changes tenant and rolls back before writing', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM partner_credit_reservations')) return {
          rows: [{ id: reservationId, business_id: '22222222-2222-4222-8222-222222222222', invoice_intent_ref: 'intent_1', state: 'reserved', units: 1, expires: false }],
        };
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as PoolClient;
    await expect(freezeAllocationTransaction(client, input())).rejects.toMatchObject({ reason: 'RESERVATION_MISMATCH' });
    expect(queries.at(-1)).toBe('ROLLBACK');
    expect(queries.some(x => x.includes('INSERT INTO'))).toBe(false);
  });
});
