import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/client';
import { MultiunitAtomicPreflight } from '../src/partner-credits/multiunit-atomic-preflight.transaction';

const request = {
  businessId:'01234567-89ab-4def-8abc-0123456789ab',
  settlementId:'01234567-89ab-4def-8abc-0123456789ac',
  earningMonthUtc:'2026-10',
  proposedUnits:3,
};
function fixture(awarded: string, existing = '0') {
  const queries: string[] = [];
  const execute = vi.fn(async (query: {queryChunks?: unknown[]}) => {
    const content = JSON.stringify(query);
    queries.push(content);
    return queries.length % 2 === 1 ? {rows:[{}]} :
      {rows:[{awarded_units:awarded,settlement_count:existing}]};
  });
  const transaction = vi.fn(async (cb: (tx: {execute: typeof execute}) => Promise<unknown>) =>
    cb({execute}));
  return {preflight:new MultiunitAtomicPreflight({transaction} as unknown as Pick<Database,'transaction'>),
    queries,execute,transaction};
}
describe('Split 07 business-month transaction preflight (non-activating)',()=>{
  it('locks, reads and rejects authorization even with cap headroom',async()=>{
    const x=fixture('4');
    const result=await x.preflight.inspect(request);
    expect(result).toEqual({status:'PREVIEW_ONLY',projectedMonthlyUnits:7,
      historicalTierVerified:false,issuanceAuthorized:false});
    expect(x.transaction).toHaveBeenCalledTimes(1);
    expect(x.execute).toHaveBeenCalledTimes(2);
    expect(x.queries[0]).toContain('pc_multiunit_month_lock');
    expect(x.queries[1]).toContain('partner_credit_award_decisions');
  });
  it('rejects a whole award at the cap boundary',async()=>{
    expect(await fixture('8').preflight.inspect(request)).toMatchObject({
      status:'MONTHLY_CAP_EXCEEDED',projectedMonthlyUnits:11,issuanceAuthorized:false,
    });
    expect(await fixture('7').preflight.inspect(request)).toMatchObject({
      status:'PREVIEW_ONLY',projectedMonthlyUnits:10,issuanceAuthorized:false,
    });
  });
  it('rejects replay even when submitted under a different month',async()=>{
    expect(await fixture('0','1').preflight.inspect(request)).toMatchObject({
      status:'AWARD_ALREADY_DECIDED',issuanceAuthorized:false,
    });
  });
  it('fails closed on unexpected results, invalid input or transaction failure',async()=>{
    expect((await fixture('-1').preflight.inspect(request)).status).toBe('DATABASE_RESULT_INVALID');
    expect((await fixture('0').preflight.inspect({...request,proposedUnits:1.5})).status)
      .toBe('INVALID_INPUT');
    const transaction=vi.fn().mockRejectedValue(new Error('rollback'));
    expect(await new MultiunitAtomicPreflight({transaction} as unknown as Pick<Database,'transaction'>)
      .inspect(request)).toMatchObject({status:'DATABASE_UNAVAILABLE',issuanceAuthorized:false});
  });
});
