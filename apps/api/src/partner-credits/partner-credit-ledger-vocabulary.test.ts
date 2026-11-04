import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { partnerCreditLedgerEntrySchema, partnerCreditLedgerEntryTypes } from '@echo-grid-feedback/shared-types';

/** R10 hardening LOW-B: the shared ledger schema accepts every type the database allows and nothing else. The live-constraint pin is in the unwind integration suite. */
const entry = (entryType: unknown, units = 1) => ({ id: randomUUID(), businessId: randomUUID(), accountId: randomUUID(), entryType, units, idempotencyKey: 'k', occurredAt: new Date().toISOString() });

describe('shared Partner Credit ledger vocabulary', () => {
  const SUPPORTED = ['provisional', 'vest', 'expire', 'reverse', 'recovery_offset', 'admin_adjustment', 'consume', 'consumed_reversal', 'reversal_noop', 'recovery_restored'];
  it('is exactly the ten authoritative types, once each', () => {
    expect([...partnerCreditLedgerEntryTypes].sort()).toEqual([...SUPPORTED].sort());
    expect(new Set(partnerCreditLedgerEntryTypes).size).toBe(partnerCreditLedgerEntryTypes.length);
  });
  it.each(SUPPORTED)('accepts a %s entry', type => {
    expect(partnerCreditLedgerEntrySchema.safeParse(entry(type, type === 'consume' || type === 'expire' || type === 'reverse' ? -1 : 1)).success).toBe(true);
  });
  it.each(['refund', 'payout', 'CONSUME', 'recovery_restore', 'reversal', 'consumed-reversal', '', ' vest', null, 7])('rejects the unknown entry type %j', type => {
    expect(partnerCreditLedgerEntrySchema.safeParse(entry(type)).success).toBe(false);
  });
  it('still rejects a zero-unit entry, as the ledger does', () => {
    expect(partnerCreditLedgerEntrySchema.safeParse(entry('vest', 0)).success).toBe(false);
  });
});
