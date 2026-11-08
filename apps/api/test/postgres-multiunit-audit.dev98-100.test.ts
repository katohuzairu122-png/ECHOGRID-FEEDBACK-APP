import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client';
import { PostgresMultiunitConservationAudit } from '../src/partner-credits/postgres-multiunit-conservation.audit';

const scope = {
  businessId: '01234567-89ab-4def-8abc-0123456789ab',
  earningMonthUtc: '2026-10',
};
const row = { month_units: '3', lot_count: '4', invalid_lots: '0' };
const denied = {
  accountingConserved: false,
  issuanceAuthorized: false,
  databaseEvidenceAvailable: false,
  reason: 'ROW_SHAPE_INVALID',
  issuedMonthUnits: 0,
  observedLots: 0,
};
function subject(response: unknown) {
  const execute = vi.fn().mockResolvedValue(response);
  const instance = new PostgresMultiunitConservationAudit({
    execute,
  } as unknown as Pick<Db, 'execute'>);
  return { instance, execute };
}

describe('Group 18 non-activating multiunit audit boundary', () => {
  it.each([
    null, undefined, [], 'not-a-scope', 42,
    { ...scope, businessId: null }, { ...scope, businessId: 123 },
    { ...scope, earningMonthUtc: null },
    { ...scope, earningMonthUtc: 202610 },
    { ...scope, earningMonthUtc: '2026-00' },
    { ...scope, earningMonthUtc: '2026-13' },
  ])('DEV-98 rejects malformed query scope before database access (%j)', async (input) => {
    const { instance, execute } = subject({ rows: [row] });
    expect(await instance.inspect(input as never)).toMatchObject({
      reason: 'INVALID_INPUT', accountingConserved: false,
      issuanceAuthorized: false, databaseEvidenceAvailable: false,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    null, undefined, {}, { rows: null }, { rows: {} },
    [], [row, row], { rows: [row, row] },
    { rows: [] }, { rows: [null] }, { rows: [[]] },
  ])('DEV-99 rejects absent, duplicate or malformed result rows (%j)', async (response) => {
    const { instance } = subject(response);
    expect(await instance.inspect(scope)).toEqual(denied);
  });

  it.each([
    { ...row, invalid_lots: '5' },
    { ...row, lot_count: '0', invalid_lots: '1' },
    { ...row, invalid_lots: '-1' },
    { ...row, lot_count: '1.5' },
    { ...row, month_units: 'not-an-integer' },
    { ...row, month_units: '9007199254740992' },
  ])('DEV-100 rejects contradictory or unsafe count aggregates (%j)', async (value) => {
    const { instance } = subject({ rows: [value] });
    expect(await instance.inspect(scope)).toEqual(denied);
  });

  it('preserves valid negative-only legacy-model verdicts', async () => {
    const { instance } = subject({ rows: [row] });
    expect(await instance.inspect(scope)).toEqual({
      accountingConserved: false, issuanceAuthorized: false,
      databaseEvidenceAvailable: true,
      reason: 'LEGACY_ALLOCATION_MODEL_INSUFFICIENT',
      issuedMonthUnits: 3, observedLots: 4,
    });
  });

  it('preserves negative-only monthly cap and lot anomaly findings', async () => {
    const overCap = subject({ rows: [{ ...row, month_units: '11' }] });
    expect(await overCap.instance.inspect(scope)).toMatchObject({
      reason: 'MONTHLY_CAP_VIOLATED', accountingConserved: false, issuanceAuthorized: false,
    });
    const invalidLot = subject({ rows: [{ ...row, invalid_lots: '1' }] });
    expect(await invalidLot.instance.inspect(scope)).toMatchObject({
      reason: 'LOT_PROJECTION_INVALID', accountingConserved: false, issuanceAuthorized: false,
    });
  });
});
