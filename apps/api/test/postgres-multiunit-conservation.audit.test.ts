import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client';
import { PostgresMultiunitConservationAudit } from '../src/partner-credits/postgres-multiunit-conservation.audit';

const input = {businessId:'01234567-89ab-4def-8abc-0123456789ab',earningMonthUtc:'2026-10'};
const subject = (result: unknown) => new PostgresMultiunitConservationAudit({
  execute:vi.fn().mockResolvedValue(result),
} as unknown as Pick<Db,'execute'>);

describe('Split 07 read-only Postgres multi-unit conservation preflight',()=>{
  it('rejects invalid tenant and month before querying',async()=>{
    const execute=vi.fn();
    const s=new PostgresMultiunitConservationAudit({execute} as unknown as Pick<Db,'execute'>);
    expect((await s.inspect({...input,businessId:'untrusted'})).reason).toBe('INVALID_INPUT');
    expect((await s.inspect({...input,earningMonthUtc:'2026-13'})).reason).toBe('INVALID_INPUT');
    expect(execute).not.toHaveBeenCalled();
  });
  it('detects monthly cap violations without approving issuance',async()=>{
    const r=await subject([{month_units:'11',lot_count:'4',invalid_lots:'0'}]).inspect(input);
    expect(r).toMatchObject({reason:'MONTHLY_CAP_VIOLATED',issuedMonthUnits:11,
      accountingConserved:false,issuanceAuthorized:false});
  });
  it('detects invalid legacy lot projections',async()=>{
    expect((await subject({rows:[{month_units:'3',lot_count:'1',invalid_lots:'1'}]})
      .inspect(input)).reason).toBe('LOT_PROJECTION_INVALID');
  });
  it('never promotes valid legacy rows to seven-bucket conservation proof',async()=>{
    expect(await subject([{month_units:'10',lot_count:'3',invalid_lots:'0'}]).inspect(input))
      .toMatchObject({reason:'LEGACY_ALLOCATION_MODEL_INSUFFICIENT',
        databaseEvidenceAvailable:true,accountingConserved:false,issuanceAuthorized:false});
  });
  it('fails closed on malformed data and unavailable database',async()=>{
    expect((await subject([{month_units:'1.5',lot_count:'1',invalid_lots:'0'}])
      .inspect(input)).reason).toBe('ROW_SHAPE_INVALID');
    const unavailable=new PostgresMultiunitConservationAudit({
      execute:vi.fn().mockRejectedValue(new Error('db offline')),
    } as unknown as Pick<Db,'execute'>);
    expect((await unavailable.inspect(input)).reason).toBe('DATABASE_UNAVAILABLE');
  });
});
