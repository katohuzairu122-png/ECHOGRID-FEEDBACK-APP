import { pgTable, uuid, text, timestamp, date, check, integer } from 'drizzle-orm/pg-core';
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
    phone: text('phone').unique(), // Nullable for email-first identity; populated E.164 values remain globally unique.
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
    ...auditColumns,
    ...softDeleteColumns,
  },
  (table) => [
    check('customers_status_check', sql`${table.status} IN ('active', 'suspended', 'banned')`),
    check(
      'customers_preferred_locale_check',
      sql`${table.preferredLocale} IS NULL OR ${table.preferredLocale} IN ('en', 'es', 'fr', 'ar')`,
    ),
  ],
);
