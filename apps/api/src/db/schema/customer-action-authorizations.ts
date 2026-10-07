import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { customers } from './customers';

export const CUSTOMER_ACTION_TYPES = [
  'redeem_reward',
  'access_orphan_settlement',
  'complete_settlement',
  'share_contact_details',
] as const;
export type CustomerActionType = (typeof CUSTOMER_ACTION_TYPES)[number];

export const CUSTOMER_ACTION_AUTHORIZATION_STATUSES = [
  'active',
  'consumed',
  'revoked',
  'expired',
] as const;
export type CustomerActionAuthorizationStatus =
  (typeof CUSTOMER_ACTION_AUTHORIZATION_STATUSES)[number];

export const customerActionAuthorizations = pgTable(
  'customer_action_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    actionType: text('action_type').$type<CustomerActionType>().notNull(),
    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),
    scope: text('scope'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    status: text('status').$type<CustomerActionAuthorizationStatus>().notNull().default('active'),
    correlationId: text('correlation_id').notNull(),
    idempotencyKey: text('idempotency_key'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  },
  (table) => [
    index('customer_action_auth_customer_business_action_status_idx').on(
      table.customerId,
      table.businessId,
      table.actionType,
      table.status,
    ),
    index('customer_action_auth_expires_at_idx').on(table.expiresAt),
    uniqueIndex('customer_action_auth_idempotency_key').on(table.idempotencyKey).where(sql`${table.idempotencyKey} IS NOT NULL`),
    check(
      'customer_action_auth_action_type_check',
      sql`${table.actionType} IN ('redeem_reward','access_orphan_settlement','complete_settlement','share_contact_details')`,
    ),
    check(
      'customer_action_auth_status_check',
      sql`${table.status} IN ('active','consumed','revoked','expired')`,
    ),
  ],
);
