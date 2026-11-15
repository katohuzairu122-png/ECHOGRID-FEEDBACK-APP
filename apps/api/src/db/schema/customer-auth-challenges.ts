import { pgTable, uuid, text, timestamp, integer, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';

/** 01D-4b-S1: security-only, customer-scoped proof challenges. Never store raw proofs or contacts. */
export const CUSTOMER_AUTH_CHALLENGE_PURPOSES = [
  'email_registration', 'email_link', 'email_recovery', 'email_change',
  'phone_attach', 'phone_change',
] as const;
export type CustomerAuthChallengePurpose = (typeof CUSTOMER_AUTH_CHALLENGE_PURPOSES)[number];

export const customerAuthChallenges = pgTable('customer_auth_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
  purpose: text('purpose').$type<CustomerAuthChallengePurpose>().notNull(),
  subjectDigest: text('subject_digest').notNull(),
  proofDigest: text('proof_digest').notNull(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, (table) => [
  index('customer_auth_challenges_subject_purpose_idx').on(table.subjectDigest, table.purpose, table.expiresAt),
  index('customer_auth_challenges_expiry_idx').on(table.expiresAt),
  check('customer_auth_challenges_purpose_check', sql`${table.purpose} IN ('email_registration', 'email_link', 'email_recovery', 'email_change', 'phone_attach', 'phone_change')`),
  check('customer_auth_challenges_subject_digest_check', sql`${table.subjectDigest} ~ '^[0-9a-f]{64}$'`),
  check('customer_auth_challenges_proof_digest_check', sql`${table.proofDigest} ~ '^[0-9a-f]{64}$'`),
  check('customer_auth_challenges_attempts_check', sql`${table.attempts} >= 0 AND ${table.maxAttempts} BETWEEN 1 AND 5 AND ${table.attempts} <= ${table.maxAttempts}`),
  check('customer_auth_challenges_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
  check('customer_auth_challenges_consumption_check', sql`${table.consumedAt} IS NULL OR (${table.consumedAt} >= ${table.createdAt} AND ${table.consumedAt} <= ${table.expiresAt})`),
]);