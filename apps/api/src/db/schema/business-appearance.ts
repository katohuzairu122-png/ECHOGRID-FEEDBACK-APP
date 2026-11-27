import { pgTable, uuid, text, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';

/**
 * PROF-01 (migration 0109): how a business appears inside the platform: a logo preset and a brand colour, both keys into
 * the built-in catalogues (shared-types BUSINESS_LOGO_KEYS / BUSINESS_BRAND_COLOR_KEYS). No uploaded file and no media:
 * the approved BDPN profile design stays untouched (this is not the public directory profile and is not moderated content).
 * Lazy: no row exists until a business first saves its appearance; nothing is backfilled.
 */
export const businessAppearance = pgTable(
  'business_appearance',
  {
    businessId: uuid('business_id')
      .primaryKey()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    logoKey: text('logo_key'),
    brandColorKey: text('brand_color_key'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (table) => [
    check('business_appearance_logo_key_check', sql`${table.logoKey} IS NULL OR ${table.logoKey} ~ '^[a-z]{2,24}$'`),
    check('business_appearance_brand_color_check', sql`${table.brandColorKey} IS NULL OR ${table.brandColorKey} ~ '^[a-z]{2,24}$'`),
  ],
);
