import { pgTable, uuid, text, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns, softDeleteColumns } from './_shared';

/**
 * A tenant. Every other tenant-owned table hangs off businessId, directly or
 * (for branch-scoped data) via branches.businessId.
 */
export const businesses = pgTable(
  'businesses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    legalName: text('legal_name'),
    industry: text('industry'),
    // BCP-47 language tag, ISO 4217 currency, IANA timezone -- app-layer
    // defaults for new branches/customers. Never assumed elsewhere.
    defaultLocale: text('default_locale').notNull().default('en'),
    defaultCurrency: text('default_currency').notNull().default('USD'),
    defaultTimezone: text('default_timezone').notNull().default('UTC'),
    status: text('status').notNull().default('active'),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (table) => [
    check(
      'businesses_status_check',
      sql`${table.status} IN ('active', 'suspended', 'archived')`,
    ),
    // Restricts default_locale to languages the platform actually has
    // translation files for (i18n & Multi-Currency Block 1/2 --
    // @echo-grid-feedback/shared-types SUPPORTED_LOCALES, messages/<locale>).
    // defaultCurrency/defaultTimezone deliberately have NO matching CHECK:
    // they only feed Intl formatting (which handles any real-world value),
    // not UI string lookup, so constraining them would be an arbitrary
    // limit rather than a reflection of what the platform supports. Keep
    // this constraint's value list in lockstep with SUPPORTED_LOCALES --
    // it is enforced independently at the DB layer for defense in depth.
    check(
      'businesses_default_locale_check',
      sql`${table.defaultLocale} IN ('en', 'es', 'fr')`,
    ),
  ],
);
