import { pgTable, uuid, text, numeric, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { branches } from './branches';
import { customers } from './customers';
import { businessCustomerMemberships } from './business-customer-memberships';
import { loyaltyAccounts } from './loyalty-accounts';

export const LOYALTY_PURCHASE_CHANNELS = [
  'branch',
  'online',
  'delivery',
  'whatsapp',
  'phone',
  'other',
] as const;
export type LoyaltyPurchaseChannel = (typeof LOYALTY_PURCHASE_CHANNELS)[number];

export const loyaltyPurchaseEvents = pgTable(
  'loyalty_purchase_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => businessCustomerMemberships.id, { onDelete: 'restrict' }),
    loyaltyAccountId: uuid('loyalty_account_id')
      .notNull()
      .references(() => loyaltyAccounts.id, { onDelete: 'restrict' }),
    idempotencyKey: text('idempotency_key').notNull(),
    externalReference: text('external_reference'),
    channel: text('channel').$type<LoyaltyPurchaseChannel>().notNull().default('branch'),
    qualifyingAmount: numeric('qualifying_amount', { precision: 10, scale: 2 }).notNull(),
    paymentStatus: text('payment_status').notNull().default('confirmed'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('loyalty_purchase_events_business_idempotency_key')
      .on(table.businessId, table.idempotencyKey),
    index('loyalty_purchase_events_account_occurred_idx').on(table.loyaltyAccountId, table.occurredAt),
    index('loyalty_purchase_events_business_branch_occurred_idx').on(
      table.businessId,
      table.branchId,
      table.occurredAt,
    ),
    check(
      'loyalty_purchase_events_channel_check',
      sql`${table.channel} IN ('branch','online','delivery','whatsapp','phone','other')`,
    ),
    check(
      'loyalty_purchase_events_payment_status_check',
      sql`${table.paymentStatus} IN ('confirmed','refunded','reversed')`,
    ),
    check('loyalty_purchase_events_amount_check', sql`${table.qualifyingAmount} > 0`),
  ],
);
