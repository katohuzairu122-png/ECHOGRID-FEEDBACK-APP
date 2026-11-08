import { describe, expect, it, vi } from 'vitest';
import { PartnerCreditProjectionAudit } from './partner-credit-projection.audit';

const account = '11111111-1111-4111-8111-111111111111';
const db = (execute: ReturnType<typeof vi.fn>) => ({ execute }) as never;
const audit = async (rows: unknown) => {
  const execute = vi.fn(async () => ({ rows }));
  const result = await new PartnerCreditProjectionAudit(db(execute)).inspect();
  return { result, execute };
};
const sentinel = (accounts: string) => ({ accounts, account_id: null, code: null, expected: null, actual: null });
const violation = (accounts = '1') => ({ accounts, account_id: account, code: 'LEDGER_NET', expected: '1', actual: '2' });
const unavailable = { status: 'unavailable', reason: 'ROW_SHAPE_INVALID' };

describe('Group 15 read-only Partner Credit projection audit integrity', () => {
  it.each([null, [], 'all', { businessId: null }, { businessId: 123 }, { businessId: '' }])(
    'DEV-89 refuses a malformed audit scope before querying (%j)', async (input) => {
      const execute = vi.fn();
      const result = await new PartnerCreditProjectionAudit(db(execute))
        .inspect(input as Parameters<PartnerCreditProjectionAudit['inspect']>[0]);
      expect(result).toEqual({ status: 'unavailable', reason: 'INVALID_INPUT' });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('DEV-89 still accepts a valid business-scoped audit', async () => {
    const execute = vi.fn(async () => ({ rows: [sentinel('0')] }));
    const result = await new PartnerCreditProjectionAudit(db(execute)).inspect({ businessId: account });
    expect(result).toEqual({ status: 'consistent', accountsInspected: 0, violations: [] });
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    [sentinel('-1')],
    [violation('1'), sentinel('2')],
    [sentinel('1'), violation('2')],
  ])('DEV-90 rejects negative or conflicting account counts', async (rows) => {
    expect((await audit(rows)).result).toEqual(unavailable);
  });

  it.each([
    [{ ...sentinel('1'), code: 'LEDGER_NET' }],
    [{ ...sentinel('1'), expected: '0' }],
    [{ ...sentinel('1'), actual: '1' }],
    [{ ...violation(), account_id: 'foreign/invalid' }, sentinel('1')],
    [{ ...violation(), expected: '2', actual: '2' }, sentinel('1')],
  ])('DEV-91 rejects sentinel corruption and fabricated violation rows', async (rows) => {
    expect((await audit(rows)).result).toEqual(unavailable);
  });

  it('preserves an actual inconsistency as non-authorizing evidence', async () => {
    const { result } = await audit([violation(), sentinel('1')]);
    expect(result).toEqual({
      status: 'inconsistent', accountsInspected: 1,
      violations: [{ accountId: account, code: 'LEDGER_NET', expected: 1, actual: 2 }],
    });
  });
});
