import { pgTable, uuid, text, timestamp, date, check, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns, softDeleteColumns } from './_shared';

/**
 * A GLOBAL customer identity, mirroring how `users` (staff) is global and
 * `user_business_roles` carries the business-scoped part -- the same split
 * applies here: `customers` is a global identity, one row per
 * customer across the WHOLE platform, and `loyalty_accounts` (below)
 * is the per-business membership. A returning customer scanning a QR code
 * at a completely different business retains the same identity.
 *
 * Never a `users` row. Customers may have a verified phone or verified
 * email credential; staff authentication and RBAC remain separate.
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // E.164, nullable (email-first identity). A phone NUMBER is only a claim until verified: several customers may
    // hold the same UNVERIFIED number, but at most one may hold it VERIFIED (partial unique index below), so the
    // verified owner is unambiguous and an unverified typed number can never block or impersonate its real owner.
    phone: text('phone'),
    fullName: text('full_name'),
    email: text('email'),
    birthday: date('birthday'), // month/day matter most (birthday rewards); full date stored, year optional in the UI
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    // Saved UI language (customer + public surfaces). NULL = no explicit choice.
    preferredLocale: text('preferred_locale'),
    // 'active' | 'suspended' | 'banned'. A suspension may carry an end time
    // (suspendedUntil); after it passes the customer is treated as active again
    // (lib/customer-access.ts). 'banned' has no end time.
    status: text('status').notNull().default('active'),
    suspendedUntil: timestamp('suspended_until', { withTimezone: true }),
    // Limited access: the customer stays 'active' (can sign in and see their own
    // account) but some features are off until this time. See
    // lib/customer-limits.ts for the list. NULL or a past time means not limited.
    limitedUntil: timestamp('limited_until', { withTimezone: true }),
    // Customer QR revocation (CUSTOMER-QR-ROTATION-01): a customer QR token carries the epoch it was issued under
    // and is rejected once the customer's epoch has moved on. Only the customer's own revoke action increments it.
    qrRevocationEpoch: integer('qr_revocation_epoch').notNull().default(0),
    // PROF-01 (migration 0109): the customer's own global profile. All optional and private to the customer, except that a
    // business may see display name + avatar of its own members. The avatar is a key into the built-in catalogue
    // (shared-types CUSTOMER_AVATAR_KEYS); there is no uploaded file.
    displayName: text('display_name'),
    bio: text('bio'),
    avatarKey: text('avatar_key'),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('customers_phone_verified_unique').on(table.phone).where(sql`${table.phoneVerifiedAt} IS NOT NULL`),
    index('customers_phone_idx').on(table.phone),
    check('customers_display_name_check', sql`${table.displayName} IS NULL OR char_length(${table.displayName}) BETWEEN 1 AND 60`),
    check('customers_bio_check', sql`${table.bio} IS NULL OR char_length(${table.bio}) <= 280`),
    check('customers_avatar_key_check', sql`${table.avatarKey} IS NULL OR ${table.avatarKey} ~ '^[a-z]{2,24}$'`),
    check('customers_status_check', sql`${table.status} IN ('active', 'suspended', 'banned')`),
    check(
      'customers_preferred_locale_check',
      sql`${table.preferredLocale} IS NULL OR ${table.preferredLocale} IN ('en', 'es', 'fr', 'ar')`,
    ),
  ],
);
