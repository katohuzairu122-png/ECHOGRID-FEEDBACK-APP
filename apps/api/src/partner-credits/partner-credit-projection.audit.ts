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
  | 'LEDGER_NET' | 'LOT_DECISION_STATE' | 'LOT_BUSINESS_MISMATCH' | 'LOT_LEDGER_ORIGIN' | 'DECISION_WITHOUT_LOT'
  | 'CONSUMED_LOT_EVIDENCE' | 'CONSUME_ENTRY_WITHOUT_LOT' | 'CONSUMED_REVERSAL_EVIDENCE' | 'CONSUMED_RESERVATION_LOT_MISMATCH' | 'APPLICATION_ALLOCATION_EVIDENCE' | 'REVERSAL_NOOP_EVIDENCE' | 'RECOVERY_RESTORED_EVIDENCE' | 'OBLIGATION_CONSERVATION';

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
const CODES = new Set<string>(['PROVISIONAL_BUCKET', 'AVAILABLE_BUCKET', 'RESERVED_BUCKET', 'RECOVERY_DUE', 'LEDGER_NET', 'LOT_DECISION_STATE', 'LOT_BUSINESS_MISMATCH', 'LOT_LEDGER_ORIGIN', 'DECISION_WITHOUT_LOT', 'CONSUMED_LOT_EVIDENCE', 'CONSUME_ENTRY_WITHOUT_LOT', 'CONSUMED_REVERSAL_EVIDENCE', 'CONSUMED_RESERVATION_LOT_MISMATCH', 'APPLICATION_ALLOCATION_EVIDENCE', 'REVERSAL_NOOP_EVIDENCE', 'RECOVERY_RESTORED_EVIDENCE', 'OBLIGATION_CONSERVATION']);

/** Ledger identity: provisional +1, vest = zero-net bucket transfer, reverse/expire/recovery_offset/consume are reductions; consumed_reversal records a debt, not a balance. */
export const LEDGER_NET_ENTRY_TYPES = ['provisional', 'reverse', 'expire', 'recovery_offset', 'consume'] as const;

export class PartnerCreditProjectionAudit {
  constructor(private readonly db: Pick<Db, 'execute'>) {}

  /** Audits one business, or every account when `businessId` is omitted. */
  async inspect(input: { businessId?: string } = {}): Promise<ProjectionAuditResult> {
    // DEV-89: a malformed scope is not an all-business audit request.
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        (input.businessId !== undefined && (typeof input.businessId !== 'string' || !UUID.test(input.businessId))))
      return { status: 'unavailable', reason: 'INVALID_INPUT' };
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
                           AND g.entry_type IN ('provisional','reverse','expire','recovery_offset','consume')), 0)::bigint,
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
          SELECT l.account_id, 'CONSUMED_LOT_EVIDENCE', COUNT(*)::bigint, 0::bigint FROM lot l
           WHERE l.status = 'consumed'
             AND NOT (
                  -- consumed through an invoice: one consume entry, a consumed reservation and its terminal application
                  ((SELECT COUNT(*) FROM partner_credit_ledger g WHERE g.decision_id = l.decision_id AND g.account_id = l.account_id
                      AND g.entry_type = 'consume' AND g.units = -1) = 1
                   AND EXISTS (SELECT 1 FROM partner_credit_reservations r
                                 JOIN billing_partner_credit_applications ap ON ap.reservation_id = r.id AND ap.terminal_state = 'applied'
                                WHERE r.lot_id = l.id AND r.state = 'consumed'))
                  -- absorbed by a recovery debt at vest (the pre-existing lifecycle path): never reserved, and it carries its recovery_offset entry
                  OR (NOT EXISTS (SELECT 1 FROM partner_credit_reservations r WHERE r.lot_id = l.id)
                      AND EXISTS (SELECT 1 FROM partner_credit_ledger g WHERE g.decision_id = l.decision_id AND g.account_id = l.account_id AND g.entry_type = 'recovery_offset')))
           GROUP BY l.account_id
          UNION ALL
          SELECT g.account_id, 'CONSUME_ENTRY_WITHOUT_LOT', COUNT(*)::bigint, 0::bigint
            FROM partner_credit_ledger g JOIN acct a ON a.id = g.account_id
           WHERE g.entry_type = 'consume'
             AND NOT EXISTS (SELECT 1 FROM partner_credit_lots x WHERE x.decision_id = g.decision_id AND x.account_id = g.account_id AND x.status IN ('consumed','reversed'))
           GROUP BY g.account_id
          UNION ALL
          SELECT g.account_id, 'REVERSAL_NOOP_EVIDENCE', COUNT(*)::bigint, 0::bigint
            FROM partner_credit_ledger g JOIN acct a ON a.id = g.account_id
           WHERE g.entry_type = 'reversal_noop'
             AND NOT (EXISTS (SELECT 1 FROM partner_credit_lots l JOIN partner_credit_award_decisions d ON d.id = l.decision_id
                               WHERE l.decision_id = g.decision_id AND l.account_id = g.account_id AND l.status = 'reversed' AND d.state = 'reversed')
                      AND EXISTS (SELECT 1 FROM partner_credit_ledger x WHERE x.decision_id = g.decision_id AND x.account_id = g.account_id AND x.entry_type = 'expire'))
           GROUP BY g.account_id
          UNION ALL
          SELECT g.account_id, 'RECOVERY_RESTORED_EVIDENCE', COUNT(*)::bigint, 0::bigint
            FROM partner_credit_ledger g JOIN acct a ON a.id = g.account_id
           WHERE g.entry_type = 'recovery_restored'
             AND NOT (EXISTS (SELECT 1 FROM partner_credit_lots l JOIN partner_credit_award_decisions d ON d.id = l.decision_id
                               WHERE l.decision_id = g.decision_id AND l.account_id = g.account_id AND l.status = 'reversed' AND d.state = 'reversed')
                      AND EXISTS (SELECT 1 FROM partner_credit_ledger x WHERE x.decision_id = g.decision_id AND x.account_id = g.account_id AND x.entry_type = 'recovery_offset'
                                   AND x.metadata->>'obligationId' = g.metadata->>'obligationId' AND x.units = -g.units)
                      AND EXISTS (SELECT 1 FROM partner_credit_recovery_obligations o WHERE o.id::text = g.metadata->>'obligationId' AND o.account_id = g.account_id))
           GROUP BY g.account_id
          UNION ALL
          SELECT o.account_id, 'OBLIGATION_CONSERVATION', COUNT(*)::bigint, 0::bigint
            FROM partner_credit_recovery_obligations o JOIN acct a ON a.id = o.account_id
           WHERE o.units_outstanding <> o.units_due
                 - COALESCE((SELECT SUM(-g.units) FROM partner_credit_ledger g WHERE g.entry_type = 'recovery_offset' AND g.account_id = o.account_id AND g.metadata->>'obligationId' = o.id::text), 0)
                 + COALESCE((SELECT SUM(g.units) FROM partner_credit_ledger g WHERE g.entry_type = 'recovery_restored' AND g.account_id = o.account_id AND g.metadata->>'obligationId' = o.id::text), 0)
           GROUP BY o.account_id
          UNION ALL
          SELECT r.account_id, 'APPLICATION_ALLOCATION_EVIDENCE', COUNT(*)::bigint, 0::bigint
            FROM billing_partner_credit_applications ap
            JOIN partner_credit_reservations r ON r.id = ap.reservation_id JOIN acct a ON a.id = r.account_id
           WHERE NOT EXISTS (SELECT 1 FROM s08_allocation_freeze_items it JOIN s08_allocation_freezes f ON f.id = it.freeze_id AND f.business_id = it.business_id
                              WHERE it.reservation_id = ap.reservation_id AND it.business_id = ap.business_id AND f.invoice_ref = ap.invoice_ref)
           GROUP BY r.account_id
          UNION ALL
          SELECT r.account_id, 'CONSUMED_RESERVATION_LOT_MISMATCH', COUNT(*)::bigint, 0::bigint
            FROM partner_credit_reservations r JOIN acct a ON a.id = r.account_id JOIN partner_credit_lots l ON l.id = r.lot_id
           WHERE r.state = 'consumed' AND l.status NOT IN ('consumed','reversed')
           GROUP BY r.account_id
          UNION ALL
          SELECT g.account_id, 'CONSUMED_REVERSAL_EVIDENCE', COUNT(*)::bigint, 0::bigint
            FROM partner_credit_ledger g JOIN acct a ON a.id = g.account_id
           WHERE g.entry_type = 'consumed_reversal'
             AND NOT (EXISTS (SELECT 1 FROM partner_credit_ledger c
                                JOIN partner_credit_lots cl ON cl.decision_id = c.decision_id
                                JOIN partner_credit_reservations cr ON cr.lot_id = cl.id AND cr.state = 'consumed'
                               WHERE c.decision_id = g.decision_id AND c.account_id = g.account_id AND c.entry_type = 'consume' AND c.metadata->>'reservationId' = cr.id::text)
                      AND EXISTS (SELECT 1 FROM partner_credit_recovery_obligations o
                                   WHERE o.account_id = g.account_id AND o.units_due = 1 AND o.reversal_ref::text = g.metadata->>'reversalEventId')
                      AND EXISTS (SELECT 1 FROM partner_credit_lots x WHERE x.decision_id = g.decision_id AND x.status = 'reversed'))
           GROUP BY g.account_id
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
      // DEV-90: count is an unsigned invariant repeated on every row.
      if (n === null || n < 0 || (accounts !== null && n !== accounts))
        return { status: 'unavailable', reason: 'ROW_SHAPE_INVALID' };
      accounts = n;
      // DEV-91: an unrecognized or partially populated sentinel cannot silently
      // discard a purported violation.
      if (row.account_id === null) {
        if (row.code !== null || row.expected !== null || row.actual !== null)
          return { status: 'unavailable', reason: 'ROW_SHAPE_INVALID' };
        continue;
      }
      const expected = int(row.expected);
      const actual = int(row.actual);
      if (typeof row.account_id !== 'string' || !UUID.test(row.account_id) ||
          typeof row.code !== 'string' || !CODES.has(row.code) ||
          expected === null || actual === null || expected === actual)
        return { status: 'unavailable', reason: 'ROW_SHAPE_INVALID' };
      violations.push({ accountId: row.account_id, code: row.code as ProjectionViolationCode, expected, actual });
    }
    if (accounts === null) return { status: 'unavailable', reason: 'ROW_SHAPE_INVALID' };
    return violations.length === 0 ? { status: 'consistent', accountsInspected: accounts, violations: [] } : { status: 'inconsistent', accountsInspected: accounts, violations };
  }
}
