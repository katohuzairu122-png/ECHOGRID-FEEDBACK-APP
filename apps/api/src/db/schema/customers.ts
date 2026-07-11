import { pgTable, uuid, text, timestamp, date, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns, softDeleteColumns } from './_shared';

/**
 * A GLOBAL customer identity, mirroring how `users` (staff) is global and
 * `user_business_roles` carries the business-scoped part -- the same split
 * applies here: `customers` is the phone-verified identity, one row per
 * phone number across the WHOLE platform, and `loyalty_accounts` (below)
 * is the per-business membership. A returning customer scanning a QR code
 * at a completely different business never re-verifies their phone.
 *
 * Never a `users` row -- customers have no staff-style login, dashboard
 * access, or RBAC. Identity is established once via SMS OTP
 * (`customer-auth/`), not a password.
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: text('phone').notNull().unique(), // E.164, e.g. +15551234567
    fullName: text('full_name'),
    email: text('email'),
    birthday: date('birthday'), // month/day matter most (birthday rewards); full date stored, year optional in the UI
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    status: text('status').notNull().default('active'),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (table) => [check('customers_status_check', sql`${table.status} IN ('active', 'suspended')`)],
);
