import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';

/**
 * Split 07 NON-ACTIVATING transactional preflight.
 * Advisory lock is scoped to ONE business across branches and UTC month.
 * No economic writes occur here. The existing 0041/0042/0044 triggers
 * deliberately prohibit economic issuance and movement.
 *
 * A later audited writer must recheck the cap and insert atomically
 * INSIDE THE SAME transaction, after authoritative tier verification.
 */
export type AtomicMultiunitPreflight = {
  issuanceAuthorized: false;
  historicalTierVerified: false;
  status: 'INVALID_INPUT' | 'DATABASE_UNAVAILABLE' | 'DATABASE_RESULT_INVALID' |
    'MONTHLY_CAP_EXCEEDED' | 'AWARD_ALREADY_DECIDED' | 'PREVIEW_ONLY';
  projectedMonthlyUnits: number | null;
};

export class MultiunitAtomicPreflight {
  constructor(private readonly db: Pick<Database,'transaction'>) {}

  async inspect(input: {
    businessId: string;
    earningMonthUtc: string;
    settlementId: string;
    proposedUnits: number;
  }): Promise<AtomicMultiunitPreflight> {
    const fail = (status: AtomicMultiunitPreflight['status'],
      projectedMonthlyUnits: number | null = null): AtomicMultiunitPreflight => ({
      issuanceAuthorized: false, historicalTierVerified: false,
      status, projectedMonthlyUnits,
    });
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(input.businessId) || !uuid.test(input.settlementId) ||
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.earningMonthUtc) ||
        ![1,2,3].includes(input.proposedUnits)) return fail('INVALID_INPUT');

    try {
      return await this.db.transaction(async tx => {
        // This lock and read are in one database transaction; there is no
        // authorization to issue. Lock is NOT a substitute for write guards.
        await tx.execute(sql`SELECT pc_multiunit_month_lock(
          ${input.businessId}::uuid, ${input.earningMonthUtc}
        )`);
        const result = await tx.execute(sql`
          SELECT
            COALESCE(SUM(award_units) FILTER (
              WHERE state IN ('provisional','vested','reversed')
            ),0)::text AS awarded_units,
            COUNT(*) FILTER (WHERE settlement_ref = ${input.settlementId}::uuid)::text
              AS settlement_count
          FROM partner_credit_award_decisions
          WHERE business_id = ${input.businessId}::uuid
            AND earning_month_utc = ${input.earningMonthUtc}
        `);
        const rows = Array.isArray(result) ? result : result.rows;
        const row = rows?.[0] as Record<string,unknown> | undefined;
        const parse = (value: unknown): number | null => {
          if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
          const numberValue = Number(value);
          return Number.isSafeInteger(numberValue) ? numberValue : null;
        };
        const issued = parse(row?.awarded_units);
        const existing = parse(row?.settlement_count);
        if (issued === null || existing === null ||
            issued > Number.MAX_SAFE_INTEGER - input.proposedUnits)
          return fail('DATABASE_RESULT_INVALID');
        const projected = issued + input.proposedUnits;
        if (existing !== 0) return fail('AWARD_ALREADY_DECIDED',projected);
        if (projected > 10) return fail('MONTHLY_CAP_EXCEEDED',projected);
        return fail('PREVIEW_ONLY',projected);
      });
    } catch {
      return fail('DATABASE_UNAVAILABLE');
    }
  }
}
