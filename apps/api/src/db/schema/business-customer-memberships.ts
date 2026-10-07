import { pgTable, uuid, text, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { customers } from './customers';
import { auditColumns, softDeleteColumns } from './_shared';

export const BUSINESS_CUSTOMER_MEMBERSHIP_STATUSES = [
  'pending',
  'active',
  'suspended',
  'left',
  'business_exited',
  'closed',
] as const;
export type BusinessCustomerMembershipStatus =
  (typeof BUSINESS_CUSTOMER_MEMBERSHIP_STATUSES)[number];

export const businessCustomerMemberships = pgTable(
  'business_customer_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    status: text('status').$type<BusinessCustomerMembershipStatus>().notNull().default('active'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    businessExitedAt: timestamp('business_exited_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    onboardingSource: text('onboarding_source'),
    onboardingReference: text('onboarding_reference'),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('business_customer_memberships_customer_business_key').on(table.customerId, table.businessId),
    index('business_customer_memberships_business_status_idx').on(table.businessId, table.status),
    index('business_customer_memberships_customer_status_idx').on(table.customerId, table.status),
    check(
      'business_customer_memberships_status_check',
      sql`${table.status} IN ('pending','active','suspended','left','business_exited','closed')`,
    ),
  ],
);
