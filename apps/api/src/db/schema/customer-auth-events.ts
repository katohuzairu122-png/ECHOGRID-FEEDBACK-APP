import { pgTable, uuid, text, timestamp, jsonb, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';

export const CUSTOMER_AUTH_EVENT_TYPES = [
  'otp_requested',
  'otp_verified',
  'otp_failed',
  'registration_completed',
  'password_set',
  'password_changed',
  'password_login_succeeded',
  'password_login_failed',
  'recovery_started',
  'recovery_completed',
  'recovery_failed',
  'session_created',
  'session_refreshed',
  'session_revoked',
  'session_replay_detected',
  'step_up_passed',
  'step_up_failed',
  'rate_limited',
  'legacy_token_used',
  'kill_switch_changed',
] as const;
export type CustomerAuthEventType = (typeof CUSTOMER_AUTH_EVENT_TYPES)[number];

export const CUSTOMER_AUTH_EVENT_OUTCOMES = ['success', 'failure', 'blocked'] as const;
export type CustomerAuthEventOutcome = (typeof CUSTOMER_AUTH_EVENT_OUTCOMES)[number];

/**
 * CUSTOMER-AUTH-01B section 5.4: append-only customer authentication audit
 * trail, kept apart from the staff/business `audit_log`. `customer_id` is
 * nullable and ON DELETE SET NULL so an event survives a customer purge and so
 * attempts against an unknown phone can be recorded. `session_id` has no FK so
 * an event outlives its session.
 *
 * Never stores a phone number, token, OTP, password or raw user agent.
 * `subject_key` is a keyed hash for unknown-account events (decision D-B4).
 * `metadata` carries allow-listed keys only, enforced by the writer.
 */
export const customerAuthEvents = pgTable(
  'customer_auth_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id'),
    eventType: text('event_type').$type<CustomerAuthEventType>().notNull(),
    outcome: text('outcome').$type<CustomerAuthEventOutcome>().notNull(),
    reasonCode: text('reason_code'),
    subjectKey: text('subject_key'),
    sourceHint: text('source_hint'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('customer_auth_events_customer_created_idx').on(table.customerId, table.createdAt),
    index('customer_auth_events_type_created_idx').on(table.eventType, table.createdAt),
    check(
      'customer_auth_events_event_type_check',
      sql`${table.eventType} IN ('otp_requested', 'otp_verified', 'otp_failed', 'registration_completed', 'password_set', 'password_changed', 'password_login_succeeded', 'password_login_failed', 'recovery_started', 'recovery_completed', 'recovery_failed', 'session_created', 'session_refreshed', 'session_revoked', 'session_replay_detected', 'step_up_passed', 'step_up_failed', 'rate_limited', 'legacy_token_used', 'kill_switch_changed')`,
    ),
    check(
      'customer_auth_events_outcome_check',
      sql`${table.outcome} IN ('success', 'failure', 'blocked')`,
    ),
    check(
      'customer_auth_events_reason_code_check',
      sql`${table.reasonCode} IS NULL OR ${table.reasonCode} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
    check(
      'customer_auth_events_source_hint_length_check',
      sql`${table.sourceHint} IS NULL OR char_length(${table.sourceHint}) <= 64`,
    ),
  ],
);
