import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';

/**
 * Split 07 PC-ECON/1 read-only projection audit ("ledger/lot projection scans", VESTING_EXPIRY_RECOVERY_COMPLETION_GATE).
 *
 * Compares the stored account counters, the lots, the award decisions, the recovery obligations and the append-only ledger of
 * the CURRENT PC-ECON/1 single-unit model with each other. It issues one SELECT, mutates nothing, and never authorizes anything:
 * a consistent result is evidence of internal consistency only, not of issuance, redemption, tier or provider authority.
 * Multi-unit (PC-ECON/2-DRAFT) accounting is a separate module and is not audited here.
 */
export type ProjectionViolationCode =
  | 'PROVISIONAL_BUCKET' | 'AVAILABLE_BUCKET' | 'RESERVED_BUCKET' | 'RECOVERY_DUE'
  | 'LEDGER_NET' | 'LOT_DECISION_STATE' | 'LOT_BUSINESS_MISMATCH' | 'LOT_LEDGER_ORIGIN' | 'DECISION_WITHOUT_LOT';

export interface ProjectionViolation {
  accountId: string;
  code: ProjectionViolationCode;
  expected: number;
  actual: number;
}

export type ProjectionAuditResult =
  | { status: 'consistent'; accountsInspected: number; violations: [] }
  | { status: 'inconsistent'; accountsInspected: number; violations: ProjectionViolation[] }
  | { status: 'unavailable'; reason: 'INVALID_INPUT' | 'DATABASE_UNAVAILABLE' | 'ROW_SHAPE_INVALID' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODES = new Set<string>(['PROVISIONAL_BUCKET', 'AVAILABLE_BUCKET', 'RESERVED_BUCKET', 'RECOVERY_DUE', 'LEDGER_NET', 'LOT_DECISION_STATE', 'LOT_BUSINESS_MISMATCH', 'LOT_LEDGER_ORIGIN', 'DECISION_WITHOUT_LOT']);

/** Ledger identity: provisional +1, vest = zero-net bucket transfer, reverse/expire/recovery_offset are reductions. */
export const LEDGER_NET_ENTRY_TYPES = ['provisional', 'reverse', 'expire', 'recovery_offset'] as const;

export class PartnerCreditProjectionAudit {
  constructor(private readonly db: Pick<Db, 'execute'>) {}

  /** Audits one business, or every account when `businessId` is omitted. */
  async inspect(input: { businessId?: string } = {}): Promise<ProjectionAuditResult> {
    if (input.businessId !== undefined && !UUID.test(input.businessId)) return { status: 'unavailable', reason: 'INVALID_INPUT' };
    const scope = input.businessId ?? null;
    let raw: unknown;
    try {
      raw = await this.db.execute(sql`
        WITH acct AS (
          SELECT * FROM partner_credit_accounts WHERE (${scope}::uuid IS NULL OR business_id = ${scope}::uuid)
        ), lot AS (
          SELECT l.*, d.state AS dstate, d.business_id AS dbusiness, d.award_units AS dunits, a.business_id AS abusiness
            FROM partner_credit_lots l
            JOIN partner_credit_award_decisions d ON d.id = l.decision_id
            JOIN acct a ON a.id = l.account_id
        ), checks AS (
          SELECT a.id AS account_id, 'PROVISIONAL_BUCKET' AS code, a.provisional::bigint AS actual,
                 COALESCE((SELECT SUM(units) FROM lot WHERE lot.account_id = a.id AND lot.status = 'provisional'), 0)::bigint AS expected FROM acct a
          UNION ALL
          SELECT a.id, 'AVAILABLE_BUCKET', a.available::bigint,
                 COALESCE((SELECT SUM(available_units) FROM lot WHERE lot.account_id = a.id AND lot.status = 'available'), 0)::bigint FROM acct a
          UNION ALL
          SELECT a.id, 'RESERVED_BUCKET', a.reserved::bigint,
                 COALESCE((SELECT SUM(units) FROM lot WHERE lot.account_id = a.id AND lot.status = 'reserved'), 0)::bigint FROM acct a
          UNION ALL
          SELECT a.id, 'RECOVERY_DUE', a.recovery_due::bigint,
                 COALESCE((SELECT SUM(units_outstanding) FROM partner_credit_recovery_obligations o WHERE o.account_id = a.id), 0)::bigint FROM acct a
          UNION ALL
          SELECT a.id, 'LEDGER_NET',
                 COALESCE((SELECT SUM(g.units) FROM partner_credit_ledger g WHERE g.account_id = a.id
                           AND g.entry_type IN ('provisional','reverse','expire','recovery_offset')), 0)::bigint,
                 (a.provisional + a.available + a.reserved)::bigint FROM acct a
          UNION ALL
          SELECT l.account_id, 'LOT_DECISION_STATE', COUNT(*)::bigint, 0::bigint FROM lot l
           WHERE NOT ((l.status = 'provisional' AND l.dstate = 'provisional')
                   OR (l.status = 'reversed' AND l.dstate = 'reversed')
                   OR (l.status IN ('available','reserved','consumed','expired') AND l.dstate = 'vested'))
           GROUP BY l.account_id
          UNION ALL
          SELECT l.account_id, 'LOT_BUSINESS_MISMATCH', COUNT(*)::bigint, 0::bigint FROM lot l
           WHERE l.dbusiness <> l.abusiness GROUP BY l.account_id
          UNION ALL
          SELECT l.account_id, 'LOT_LEDGER_ORIGIN', COUNT(*)::bigint, 0::bigint FROM lot l
           WHERE (SELECT COUNT(*) FROM partner_credit_ledger g WHERE g.decision_id = l.decision_id
                    AND g.account_id = l.account_id AND g.entry_type = 'provisional' AND g.units = 1) <> 1
           GROUP BY l.account_id
          UNION ALL
          SELECT a.id, 'DECISION_WITHOUT_LOT', COUNT(*)::bigint, 0::bigint FROM acct a
            JOIN partner_credit_award_decisions d ON d.business_id = a.business_id
           WHERE d.state IN ('provisional','vested','reversed') AND d.award_units > 0
             AND NOT EXISTS (SELECT 1 FROM partner_credit_lots x WHERE x.decision_id = d.id)
           GROUP BY a.id
        )
        SELECT (SELECT COUNT(*) FROM acct)::text AS accounts,
               c.account_id::text AS account_id, c.code, c.expected::text AS expected, c.actual::text AS actual
          FROM checks c
         WHERE c.expected <> c.actual
         UNION ALL
        SELECT (SELECT COUNT(*) FROM acct)::text, NULL, NULL, NULL, NULL
         ORDER BY 2 NULLS LAST, 3
      `);
    } catch {
      return { status: 'unavailable', reason: 'DATABASE_UNAVAILABLE' };
    }
    const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && 'rows' in raw && Array.isArray((raw as { rows: unknown }).rows) ? (raw as { rows: unknown[] }).rows : null;
    if (!rows || rows.length === 0) return { status: 'unavailable', reason: 'ROW_SHAPE_INVALID' };
    const int = (v: unknown) => (typeof v === 'string' && /^-?\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null);
    const violations: ProjectionViolation[] = [];
    let accounts: number | null = null;
    for (const r of rows) {
      if (!r || typeof r !== 'object') return { status: 'unavailable', reason: 'ROW_SHAPE_INVALID' };
      const row = r as Record<string, unknown>;
      const n = int(row.accounts);
      if (n === null) return { status: 'unavailable', reason: 'ROW_SHAPE_INVALID' };
      accounts = n;
      if (row.account_id === null) continue; // sentinel row carrying the account count
      const expected = int(row.expected);
      const actual = int(row.actual);
      if (typeof row.account_id !== 'string' || typeof row.code !== 'string' || !CODES.has(row.code) || expected === null || actual === null) return { status: 'unavailable', reason: 'ROW_SHAPE_INVALID' };
      violations.push({ accountId: row.account_id, code: row.code as ProjectionViolationCode, expected, actual });
    }
    if (accounts === null) return { status: 'unavailable', reason: 'ROW_SHAPE_INVALID' };
    return violations.length === 0 ? { status: 'consistent', accountsInspected: accounts, violations: [] } : { status: 'inconsistent', accountsInspected: accounts, violations };
  }
}
