import {
  pgTable,
  uuid,
  text,
  timestamp,
  check,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';

/**
 * CUSTOMER-AUTH-01B section 5.1: one password credential per customer. A
 * customer with no row here has no password (every customer before the
 * password feature). The primary key IS the customer id, so a second
 * credential for one customer is impossible by construction.
 *
 * Deliberately NOT spread with auditColumns/softDeleteColumns, same as
 * `refresh_tokens`: a security artifact, not business data, and the customer
 * is the only actor so `created_by` would carry nothing.
 *
 * `password_hash` is the self-describing PBKDF2 string from auth/password.ts
 * (algorithm, iterations and salt travel with it). It must never appear in any
 * read model or log. This is customer-only storage: it never reuses staff
 * `users` rows, hashes or reset tokens.
 */
export const customerCredentials = pgTable(
  'customer_credentials',
  {
    customerId: uuid('customer_id')
      .primaryKey()
      .references(() => customers.id, { onDelete: 'cascade' }),
    // Authentication identity is separate from the editable customers.email profile field.
    loginEmail: text('login_email'),
    loginEmailVerifiedAt: timestamp('login_email_verified_at', {
      withTimezone: true,
    }),
    passwordHash: text('password_hash').notNull(),
    passwordSetAt: timestamp('password_set_at', {
      withTimezone: true,
    }).notNull(),
    passwordChangedAt: timestamp('password_changed_at', {
      withTimezone: true,
    }).notNull(),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    // Proposed MG-02. A credentialed customer's legacy 90-day JWTs at or before
    // this cutoff must not authenticate. Nullable for compatibility only.
    legacyTokensInvalidBefore: timestamp('legacy_tokens_invalid_before', {
      withTimezone: true,
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('customer_credentials_login_email_uidx').on(table.loginEmail),
    check(
      'customer_credentials_verified_login_email_check',
      sql`(${table.loginEmail} IS NULL AND ${table.loginEmailVerifiedAt} IS NULL) OR (${table.loginEmail} IS NOT NULL AND ${table.loginEmailVerifiedAt} IS NOT NULL AND ${table.loginEmail} <> '' AND ${table.loginEmail} = lower(btrim(${table.loginEmail})))`,
    ),
  ],
);
