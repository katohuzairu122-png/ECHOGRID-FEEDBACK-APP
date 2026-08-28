import { pgTable, uuid, text, integer, numeric, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { loyaltyAccounts } from './loyalty-accounts';
import { loyaltyRewards } from './loyalty-rewards';
import { qrCodes } from './qr-codes';
import { visitSessions } from './visit-sessions';

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
    // set only for type='checkin', and only when visit verification (Block
    // 4.3.2) actually succeeded on that request -- see the partial unique
    // index below (Block 5.2, S5.7 one reward per qualifying visit)
    visitSessionId: uuid('visit_session_id').references(() => visitSessions.id, {
      onDelete: 'set null',
    }),
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
    // IS NOT NULL-scoped only (no explicit type='checkin' clause) --
    // matches loyalty_transactions_redemption_code_key's own precedent
    // immediately above: visitSessionId is only ever populated for
    // type='checkin' by the same application-level convention
    // redemptionCode already relies on for type='redemption'.
    uniqueIndex('loyalty_transactions_checkin_visit_key')
      .on(table.visitSessionId, table.loyaltyAccountId)
      .where(sql`${table.visitSessionId} IS NOT NULL`),
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
