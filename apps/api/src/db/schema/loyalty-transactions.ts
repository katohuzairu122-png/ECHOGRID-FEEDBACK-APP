import { pgTable, uuid, text, integer, numeric, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { loyaltyAccounts } from './loyalty-accounts';
import { loyaltyRewards } from './loyalty-rewards';
import { qrCodes } from './qr-codes';
import { visitSessions } from './visit-sessions';
import { feedback } from './feedback';

/**
 * Append-only points ledger, mirroring `audit_log`'s design -- the source
 * of truth behind `loyalty_accounts.points`'s denormalized running total.
 * No soft-delete columns (a ledger entry is never removed), and `type` DOES
 * get a CHECK constraint (unlike `qr_codes.type`) because every
 * point-earning/spending mechanism this module supports is fully designed
 * now, not speculative future values.
 *
 * One deliberate, narrow exception to "append-only": `redemption_confirmed_at`
 * is set via a single one-way UPDATE once staff confirms a redemption at
 * the counter. This mirrors `feedback.status` transitioning new -> reviewed
 * -- a status change on the row, not an edit to the substantive
 * points/type/amount fields, which never change after insert.
 */
export const loyaltyTransactions = pgTable(
  'loyalty_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loyaltyAccountId: uuid('loyalty_account_id')
      .notNull()
      .references(() => loyaltyAccounts.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    points: integer('points').notNull(), // positive = earned, negative = redeemed/adjusted down
    relatedRewardId: uuid('related_reward_id').references(() => loyaltyRewards.id, {
      onDelete: 'set null',
    }), // set only for type='redemption'
    relatedQrCodeId: uuid('related_qr_code_id').references(() => qrCodes.id, {
      onDelete: 'set null',
    }), // set only for type='checkin'
    // Originally "set only for type='checkin'" (Block 4.3.2/5.2). Continuing
    // Development Block 2 (S6.1 limitPer='visit' prerequisite) widened this:
    // also settable for type='redemption', when the customer's redeem()/
    // issue() call supplies a visitProof that verifies successfully (see
    // LoyaltyRedemptionService.resolveRedemptionReferences). Still only ever
    // set when verification actually succeeded on that request -- see the
    // partial unique index below (Block 5.2, S5.7 one reward per qualifying
    // visit; Block 2's own note there on why it's now type-scoped).
    visitSessionId: uuid('visit_session_id').references(() => visitSessions.id, {
      onDelete: 'set null',
    }),
    // Continuing Development Block 2 (S6.4 minimum feedback requirements
    // prerequisite). Set only for type='redemption', and only when the
    // customer's redeem()/issue() call supplies a feedbackId that resolves
    // to a real row in THIS business (see resolveRedemptionReferences' own
    // comment for why an unresolved id is silently dropped rather than
    // rejected). Nullable: most redemptions won't reference specific
    // feedback -- this column only becomes load-bearing once a future block
    // enforces loyalty_rewards.minCommentLength against the linked row's
    // comment. onDelete 'set null', matching relatedRewardId/
    // relatedQrCodeId/visitSessionId's identical convention on this same
    // table -- this ledger row's own existence must never depend on whether
    // a since-deleted feedback row still exists.
    feedbackId: uuid('feedback_id').references(() => feedback.id, { onDelete: 'set null' }),
    purchaseAmount: numeric('purchase_amount', { precision: 10, scale: 2 }), // set only for type='purchase'
    redemptionCode: text('redemption_code').unique(), // set only for type='redemption'
    redemptionConfirmedAt: timestamp('redemption_confirmed_at', { withTimezone: true }),
    // Continuing Development Block 6.2 (S6.7 reward state machine). Only
    // ever set for type='redemption' rows whose relatedRewardId points at a
    // NON-'points' loyalty_rewards.type (discount/free_item/voucher) -- NULL
    // for every points-type redemption (today's existing flow, completely
    // unchanged) and every other transaction type. Only 'issued' and
    // 'redeemed' are reachable today (LoyaltyRedemptionService.issue()/
    // confirmRedemption()); 'pending'/'expired'/'reversed' are valid in the
    // CHECK below so a later block (expiry, reversal) doesn't need a second
    // migration just to widen this enum.
    issuanceStatus: text('issuance_status'),
    notes: text('notes'), // free-text, e.g. for manual 'adjustment' entries
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'), // staff actor for purchase/adjustment/redemption-confirm; NULL for customer-initiated checkin/redemption-request
  },
  (table) => [
    index('loyalty_transactions_account_created_idx').on(table.loyaltyAccountId, table.createdAt),
    uniqueIndex('loyalty_transactions_redemption_code_key')
      .on(table.redemptionCode)
      .where(sql`${table.redemptionCode} IS NOT NULL`),
    // Continuing Development Block 5.2 (S5.7 one reward per qualifying
    // visit). Composite on (visitSessionId, loyaltyAccountId), NOT
    // visitSessionId alone -- a shared table-session code
    // (visit_sessions.maxUses = null) is meant to be used by MANY different
    // customers at that table, each earning their own reward once. A bare
    // visitSessionId-only index would let the FIRST customer's checkin
    // permanently block every other customer who scans the same shared
    // code. This composite key instead blocks only a single account from
    // claiming the same visit session twice, while leaving every other
    // account free to claim their own first checkin against it.
    // Originally IS NOT NULL-scoped only, relying on the application-level
    // convention that visitSessionId was populated for type='checkin' rows
    // alone. Continuing Development Block 2 breaks that convention on
    // purpose (visitSessionId is now also set on type='redemption' rows --
    // see that column's own comment above), which would otherwise make this
    // index wrongly block a customer's second reward claim against a visit
    // session they'd already used for check-in: same visitSessionId, same
    // loyaltyAccountId, two legitimately different transaction types. The
    // added `type = 'checkin'` clause restores this index to its original,
    // still-correct intent (one checkin reward per qualifying visit per
    // account) without also constraining redemption rows, which have no
    // such one-per-visit rule today. Found and fixed here, before it could
    // ship as a live bug -- not discovered via a later failure.
    uniqueIndex('loyalty_transactions_checkin_visit_key')
      .on(table.visitSessionId, table.loyaltyAccountId)
      .where(sql`${table.visitSessionId} IS NOT NULL AND ${table.type} = 'checkin'`),
    // Continuing Development Block 6.5 (S5.5 customer cooldown + S6.1
    // "one reward per ... defined period"). Backs
    // LoyaltyTransactionRepository.findLastRedemptionForAccount()'s exact
    // access pattern: equality on (relatedRewardId, loyaltyAccountId),
    // ORDER BY createdAt DESC LIMIT 1. Partial (relatedRewardId IS NOT
    // NULL) for the same reason loyalty_transactions_checkin_visit_key is
    // partial on visitSessionId immediately above -- relatedRewardId is
    // only ever set for type='redemption' rows, so a non-partial index
    // would carry dead weight for every checkin/purchase/bonus/adjustment
    // row. Not unique -- a customer legitimately has many redemption rows
    // for the same reward over time (that's the history this index exists
    // to search), unlike the checkin-visit key above, which really is a
    // one-time claim per (session, account) pair.
    index('loyalty_transactions_reward_account_created_idx')
      .on(table.relatedRewardId, table.loyaltyAccountId, table.createdAt)
      .where(sql`${table.relatedRewardId} IS NOT NULL`),
    check(
      'loyalty_transactions_type_check',
      sql`${table.type} IN ('checkin', 'purchase', 'redemption', 'referral_bonus', 'birthday_bonus', 'adjustment')`,
    ),
    check(
      'loyalty_transactions_issuance_status_check',
      sql`${table.issuanceStatus} IS NULL OR ${table.issuanceStatus} IN ('pending', 'issued', 'redeemed', 'expired', 'reversed')`,
    ),
  ],
);
