import { pgTable, uuid, text, doublePrecision, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns, softDeleteColumns } from './_shared';
import { businesses } from './businesses';

/**
 * A physical or logical location belonging to a business. QR codes, feedback,
 * and loyalty check-ins are always scoped to a branch.
 */
export const branches = pgTable(
  'branches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    stateProvince: text('state_province'),
    postalCode: text('postal_code'),
    countryCode: text('country_code'), // ISO 3166-1 alpha-2
    timezone: text('timezone').notNull().default('UTC'),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    status: text('status').notNull().default('active'),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('branches_business_id_slug_key').on(table.businessId, table.slug),
    check('branches_status_check', sql`${table.status} IN ('active', 'inactive', 'archived')`),
  ],
);
