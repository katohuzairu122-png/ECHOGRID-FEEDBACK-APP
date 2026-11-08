import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';

/**
 * NON-ACTIVATING, database-backed preflight for PC-ECON/2-DRAFT.
 * Executes one parameterized SELECT statement (one PostgreSQL statement
 * snapshot). It intentionally cannot prove seven-bucket conservation from
 * the legacy single-status lot schema; no affirmative accounting/issuance
 * authority is ever returned.
 *
 * Existing SQL write denials in migrations 0041 and 0042 remain untouched.
 */
export type MultiunitDatabaseAudit = {
  accountingConserved: false;
  issuanceAuthorized: false;
  databaseEvidenceAvailable: boolean;
  reason: 'INVALID_INPUT' | 'DATABASE_UNAVAILABLE' | 'ROW_SHAPE_INVALID' |
    'MONTHLY_CAP_VIOLATED' | 'LOT_PROJECTION_INVALID' |
    'LEGACY_ALLOCATION_MODEL_INSUFFICIENT';
  issuedMonthUnits: number;
  observedLots: number;
};

export class PostgresMultiunitConservationAudit {
  constructor(private readonly db: Pick<Db, 'execute'>) {}
  async inspect(input: {
    businessId: string;
    earningMonthUtc: string;
  }): Promise<MultiunitDatabaseAudit> {
    const deny = (
      reason: MultiunitDatabaseAudit['reason'], issuedMonthUnits = 0,
      observedLots = 0, databaseEvidenceAvailable = false,
    ): MultiunitDatabaseAudit => ({
      accountingConserved: false, issuanceAuthorized: false,
      databaseEvidenceAvailable, reason, issuedMonthUnits, observedLots,
    });
    // DEV-98: reject malformed runtime scopes before issuing any query.
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        typeof input.businessId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.businessId) ||
        typeof input.earningMonthUtc !== 'string' ||
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.earningMonthUtc))
      return deny('INVALID_INPUT');
    // Business-scoped aggregate from the immutable award decisions and
    // existing lots. Never mistake this for an award lock or a ledger proof:
    // the old lot schema cannot express all seven disjoint unit buckets.
    let raw: unknown;
    try {
      raw = await this.db.execute(sql`
        SELECT
          COALESCE((SELECT SUM(d.award_units)
            FROM partner_credit_award_decisions d
            WHERE d.business_id = ${input.businessId}::uuid
              AND d.earning_month_utc = ${input.earningMonthUtc}
              AND d.state IN ('provisional','vested','reversed')),0)::text AS month_units,
          (SELECT COUNT(*) FROM partner_credit_lots l
             JOIN partner_credit_award_decisions d ON d.id = l.decision_id
            WHERE d.business_id = ${input.businessId}::uuid)::text AS lot_count,
          (SELECT COUNT(*) FROM partner_credit_lots l
             JOIN partner_credit_award_decisions d ON d.id = l.decision_id
            WHERE d.business_id = ${input.businessId}::uuid
              AND (l.units <= 0 OR l.available_units < 0 OR
                l.available_units > l.units OR
                (l.status = 'provisional' AND l.available_units <> 0) OR
                (l.status IN ('consumed','expired','reversed') AND l.available_units <> 0)
              ))::text AS invalid_lots
      `);
    } catch {
      return deny('DATABASE_UNAVAILABLE');
    }
    // DEV-99: this aggregate SELECT must return exactly one row. Never
    // silently trust one result from a duplicate/partial/malformed envelope.
    const rows: unknown = Array.isArray(raw) ? raw
      : raw && typeof raw === 'object' && 'rows' in raw ? raw.rows : undefined;
    if (!Array.isArray(rows) || rows.length !== 1) return deny('ROW_SHAPE_INVALID');
    const candidate: unknown = rows[0];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return deny('ROW_SHAPE_INVALID');
    const row = candidate as Record<string,unknown>;
    const parse = (v: unknown) => {
      if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
      const n = Number(v);
      return Number.isSafeInteger(n) ? n : null;
    };
    const month = parse(row.month_units);
    const count = parse(row.lot_count);
    const invalid = parse(row.invalid_lots);
    // DEV-100: invalid_lots is a subset of counted lots. Treat impossible
    // aggregates as unavailable, not valid evidence of conservation.
    if (month === null || count === null || invalid === null || invalid > count)
      return deny('ROW_SHAPE_INVALID');
    if (month > 10) return deny('MONTHLY_CAP_VIOLATED',month,count,true);
    if (invalid > 0) return deny('LOT_PROJECTION_INVALID',month,count,true);
    return deny('LEGACY_ALLOCATION_MODEL_INSUFFICIENT',month,count,true);
  }
}
