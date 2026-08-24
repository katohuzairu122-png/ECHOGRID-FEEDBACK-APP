import { pgTable, uuid, text, integer, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns, softDeleteColumns } from './_shared';
import { businesses } from './businesses';
import { branches } from './branches';

/**
 * Continuing Development Block 4.2 (S5.3 visit verification). A staff-issued
 * code a customer presents as evidence of a real visit before their feedback
 * submission or loyalty check-in counts toward anything reward-eligible.
 *
 * One table, two spec items. S5.3 asks for several distinct verification
 * flavors ("receipt number, POS order identifier, one-time visit token,
 * table session, staff-issued visit session, external POS reference") --
 * `maxUses` is what separates the two this block actually ships, without
 * needing two tables or two code paths:
 *   - `maxUses = null` -- a TABLE SESSION: unlimited redemptions until
 *     `expiresAt`, meant for a code shown once (a table tent, a receipt
 *     footer) that many customers at that table/service window can each
 *     enter once.
 *   - `maxUses = 1` (or any N) -- a ONE-TIME VISIT TOKEN: exhausted after
 *     its Nth successful use regardless of how much of `expiresAt`'s window
 *     remains.
 * `visit-session.service.ts`'s `issue()` takes both as explicit caller
 * arguments -- there is no hardcoded "session mode" vs "token mode," just a
 * different ttl/maxUses choice at the call site.
 *
 * Receipt-number, POS-order-ID, and external-POS-reference verification are
 * deliberately NOT built here -- see visits/visit-verification.ts's own doc
 * comment for why (no real POS integration exists in this account to
 * validate against, and inventing one would mean either a placeholder or a
 * guessed API, both against this project's own execution rules). The
 * `VisitVerificationProvider` interface those files define is what keeps
 * adding a real POS provider later a new file, not a redesign of this table
 * or its two existing callers (feedback submit, loyalty check-in -- wired in
 * Block 4.3).
 *
 * No 'expired' status value, matching qr_codes' own status design: whether
 * a session is still usable is computed from `expiresAt` (and `maxUses` vs
 * `useCount`) at verify time, not maintained by a background job that
 * flips a column. `status` only ever holds the two states a STAFF ACTION
 * produces -- 'active' or 'revoked' -- the same reasoning qr_codes.ts's own
 * comment gives for its own two-value status column.
 *
 * `useCount` is a live, mutated counter (not append-only like
 * fraud_signals), so this table keeps softDeleteColumns/auditColumns'
 * qr_codes-style shape rather than fraud_signals' no-delete, actor-less one
 * -- a session is staff-created and staff-revocable content, not a
 * detector's own finding.
 */
export const visitSessions = pgTable(
  'visit_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    /** Human-typeable code the customer enters -- see
     * visits/visit-session-code.ts for the generation scheme. Uniqueness is
     * enforced only among currently-active sessions (the partial index
     * below), not globally-forever: a revoked or long-expired session's old
     * code is free to be reissued. */
    code: text('code').notNull(),
    status: text('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Null = unlimited uses until expiresAt (a table session). A positive
     * integer = exhausted after that many successful verifications (a
     * one-time-or-N-time token). Never zero or negative -- see the CHECK
     * constraint below; a session with no uses available is meaningless to
     * create in the first place. */
    maxUses: integer('max_uses'),
    useCount: integer('use_count').notNull().default(0),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (table) => [
    // At most one ACTIVE session per branch per code -- same
    // qr_codes_branch_type_active_key shape/reasoning. A Postgres partial
    // index predicate must be immutable, which is exactly why this checks
    // `status`, a stored column, rather than `expiresAt > now()`, a
    // function of the current time.
    uniqueIndex('visit_sessions_branch_code_active_key')
      .on(table.branchId, table.code)
      .where(sql`${table.status} = 'active'`),
    index('visit_sessions_business_branch_idx').on(table.businessId, table.branchId),
    check('visit_sessions_status_check', sql`${table.status} IN ('active', 'revoked')`),
    check('visit_sessions_max_uses_check', sql`${table.maxUses} IS NULL OR ${table.maxUses} > 0`),
  ],
);
