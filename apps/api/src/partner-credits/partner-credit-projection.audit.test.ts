import { describe, it, expect } from 'vitest';
import { PartnerCreditProjectionAudit } from './partner-credit-projection.audit';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const db = (impl: () => Promise<unknown>) => ({ execute: impl }) as never;
const sentinel = (accounts: string) => ({ accounts, account_id: null, code: null, expected: null, actual: null });

describe('PartnerCreditProjectionAudit (response handling; SQL is exercised on PostgreSQL in the isolated integration test)', () => {
  it('reports consistent when only the account-count sentinel row is returned', async () => {
    const r = await new PartnerCreditProjectionAudit(db(async () => ({ rows: [sentinel('3')] }))).inspect();
    expect(r).toEqual({ status: 'consistent', accountsInspected: 3, violations: [] });
  });
  it('maps violation rows to typed violations', async () => {
    const r = await new PartnerCreditProjectionAudit(db(async () => [
      { accounts: '2', account_id: A, code: 'AVAILABLE_BUCKET', expected: '1', actual: '2' }, sentinel('2'),
    ])).inspect({ businessId: B });
    expect(r).toEqual({ status: 'inconsistent', accountsInspected: 2, violations: [{ accountId: A, code: 'AVAILABLE_BUCKET', expected: 1, actual: 2 }] });
  });
  it('rejects a malformed business id without touching the database', async () => {
    let called = false;
    const r = await new PartnerCreditProjectionAudit(db(async () => { called = true; return []; })).inspect({ businessId: 'not-a-uuid' });
    expect(r).toEqual({ status: 'unavailable', reason: 'INVALID_INPUT' });
    expect(called).toBe(false);
  });
  it('fails closed: a thrown query, an empty result and unknown codes or numbers never read as consistent', async () => {
    const run = (x: () => Promise<unknown>) => new PartnerCreditProjectionAudit(db(x)).inspect();
    expect(await run(async () => { throw new Error('boom'); })).toEqual({ status: 'unavailable', reason: 'DATABASE_UNAVAILABLE' });
    expect(await run(async () => ({ rows: [] }))).toEqual({ status: 'unavailable', reason: 'ROW_SHAPE_INVALID' });
    expect(await run(async () => undefined)).toEqual({ status: 'unavailable', reason: 'ROW_SHAPE_INVALID' });
    expect(await run(async () => [{ accounts: '1', account_id: A, code: 'MADE_UP', expected: '0', actual: '1' }])).toEqual({ status: 'unavailable', reason: 'ROW_SHAPE_INVALID' });
    expect(await run(async () => [{ accounts: '1', account_id: A, code: 'LEDGER_NET', expected: 'x', actual: '1' }])).toEqual({ status: 'unavailable', reason: 'ROW_SHAPE_INVALID' });
    expect(await run(async () => [{ accounts: 'many', account_id: null }])).toEqual({ status: 'unavailable', reason: 'ROW_SHAPE_INVALID' });
    expect(await run(async () => [{ accounts: '1', account_id: A, code: 'LEDGER_NET', expected: '0', actual: '1' }])).toEqual({
      status: 'inconsistent', accountsInspected: 1, violations: [{ accountId: A, code: 'LEDGER_NET', expected: 0, actual: 1 }],
    });
  });
});
