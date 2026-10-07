import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { customers } from './customers';

export const CONSENT_PURPOSES = [
  'join_loyalty',
  'marketing',
  'survey_participation',
  'settlement_access',
  'contact_sharing',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const CONSENT_STATUSES = ['active', 'revoked', 'expired', 'consumed'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const consentGrants = pgTable(
  'consent_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'set null' }),
    purpose: text('purpose').$type<ConsentPurpose>().notNull(),
    scope: text('scope'),
    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),
    consentVersion: text('consent_version').notNull().default('v1'),
    status: text('status').$type<ConsentStatus>().notNull().default('active'),
    idempotencyKey: text('idempotency_key'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('consent_grants_customer_business_purpose_status_idx').on(
      table.customerId,
      table.businessId,
      table.purpose,
      table.status,
    ),
    index('consent_grants_resource_idx').on(table.resourceId),
    uniqueIndex('consent_grants_idempotency_key').on(table.idempotencyKey).where(sql`${table.idempotencyKey} IS NOT NULL`),
    check(
      'consent_grants_purpose_check',
      sql`${table.purpose} IN ('join_loyalty','marketing','survey_participation','settlement_access','contact_sharing')`,
    ),
    check(
      'consent_grants_status_check',
      sql`${table.status} IN ('active','revoked','expired','consumed')`,
    ),
  ],
);
