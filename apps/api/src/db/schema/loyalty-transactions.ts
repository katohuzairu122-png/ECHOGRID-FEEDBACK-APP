import { pgTable, uuid, text, integer, numeric, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { loyaltyAccounts } from './loyalty-accounts';
import { loyaltyRewards } from './loyalty-rewards';
import { qrCodes } from './qr-codes';

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
    purchaseAmount: numeric('purchase_amount', { precision: 10, scale: 2 }), // set only for type='purchase'
    redemptionCode: text('redemption_code').unique(), // set only for type='redemption'
    redemptionConfirmedAt: timestamp('redemption_confirmed_at', { withTimezone: true }),
    notes: text('notes'), // free-text, e.g. for manual 'adjustment' entries
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'), // staff actor for purchase/adjustment/redemption-confirm; NULL for customer-initiated checkin/redemption-request
  },
  (table) => [
    index('loyalty_transactions_account_created_idx').on(table.loyaltyAccountId, table.createdAt),
    uniqueIndex('loyalty_transactions_redemption_code_key')
      .on(table.redemptionCode)
      .where(sql`${table.redemptionCode} IS NOT NULL`),
    check(
      'loyalty_transactions_type_check',
      sql`${table.type} IN ('checkin', 'purchase', 'redemption', 'referral_bonus', 'birthday_bonus', 'adjustment')`,
    ),
  ],
);
