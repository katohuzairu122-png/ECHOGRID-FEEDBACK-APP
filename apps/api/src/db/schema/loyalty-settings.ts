import { pgTable, uuid, integer, numeric, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { auditColumns } from './_shared';

/**
 * Per-business earning-rate configuration for the points engine (Loyalty
 * Block 3). Added alongside Block 3, not Block 1, because it only became
 * clear the points engine needed it once actually writing the earning
 * logic -- a fixed "10 points per check-in" constant would violate this
 * project's standing "never hard-code limits" rule the moment two
 * businesses want different rates, which is the normal case for a
 * multi-tenant platform. One row per business (unique index below); the
 * repository's getOrCreateDefaults() lazily inserts a default row on first
 * read, so this is invisible to callers created before this table existed.
 *
 * No soft-delete columns -- deleted alongside its business via cascade,
 * never independently "removed" while the business still exists.
 */
export const loyaltySettings = pgTable(
  'loyalty_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    pointsPerCheckin: integer('points_per_checkin').notNull().default(10),
    // Points earned per whole currency unit spent (e.g. 1.00 = $1 -> 1pt).
    // numeric, not integer, so a business can set fractional rates (e.g. 0.5).
    pointsPerCurrencyUnit: numeric('points_per_currency_unit', { precision: 6, scale: 2 })
      .notNull()
      .default('1.00'),
    referralBonusPoints: integer('referral_bonus_points').notNull().default(50),
    birthdayBonusPoints: integer('birthday_bonus_points').notNull().default(100),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('loyalty_settings_business_id_key').on(table.businessId),
    check('loyalty_settings_points_per_checkin_check', sql`${table.pointsPerCheckin} >= 0`),
    check('loyalty_settings_points_per_currency_unit_check', sql`${table.pointsPerCurrencyUnit} >= 0`),
    check('loyalty_settings_referral_bonus_check', sql`${table.referralBonusPoints} >= 0`),
    check('loyalty_settings_birthday_bonus_check', sql`${table.birthdayBonusPoints} >= 0`),
  ],
);
