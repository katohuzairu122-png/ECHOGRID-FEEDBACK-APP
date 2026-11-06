import { pgTable, uuid, text, bigint, integer, boolean, timestamp, check, foreignKey, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

/**
 * S08-D1D3-DEV-13: durable administration of the Stripe read-authorization POLICY (migration 0064). DEVELOPMENT ONLY and inert.
 *
 * A policy-change REQUEST asks that `stripe_read_authorization_policy.approval_enabled` become a target value, written against an expected policy version. Requests are PENDING until a DISTINCT
 * platform administrator approves, rejects or cancels them, or they expire. APPROVING A REQUEST NEVER CHANGES THE POLICY: no function, trigger or API in this system applies a request to the policy.
 * The switch stays owner-controlled and out of band; an approved request is evidence a future, separately designated owner authority would have to present. At most one live (PENDING or APPROVED)
 * request exists per policy version, so a stale request can never override a newer decision.
 */
export const stripeReadPolicyChanges = pgTable('stripe_read_policy_changes', {
  id: uuid('id').primaryKey().defaultRandom(),
  seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
  expectedPolicyVersion: integer('expected_policy_version').notNull(),
  targetState: boolean('target_state').notNull(),
  state: text('state').$type<'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED'>().notNull(),
  version: integer('version').notNull().default(1),
  justification: text('justification').notNull(),
  proposedBy: uuid('proposed_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  expiresAtMs: bigint('expires_at_ms', { mode: 'number' }).notNull(),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'restrict' }),
  decidedAtMs: bigint('decided_at_ms', { mode: 'number' }),
  decisionRef: text('decision_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  check('stripe_read_policy_change_state_check', sql`${t.state} IN ('PENDING','APPROVED','REJECTED','CANCELLED','EXPIRED')`),
  check('stripe_read_policy_change_text_check', sql`${t.justification} ~ '^[ -~]{1,255}$'`),
  check('stripe_read_policy_change_window_check', sql`${t.expectedPolicyVersion} >= 1 AND ${t.version} >= 1 AND ${t.expiresAtMs} > 0`),
  check('stripe_read_policy_change_fields_check', sql`(${t.state} = 'PENDING' AND ${t.decidedBy} IS NULL AND ${t.decidedAtMs} IS NULL AND ${t.decisionRef} IS NULL)
    OR (${t.state} <> 'PENDING' AND ${t.decidedBy} IS NOT NULL AND ${t.decidedAtMs} IS NOT NULL AND ${t.decisionRef} IS NOT NULL AND ${t.decisionRef} ~ '^[!-~]{1,255}$')`),
  // one live request per policy version: duplicate and competing proposals are refused, and a stale one can never override a newer decision
  uniqueIndex('stripe_read_policy_change_live_key').on(t.expectedPolicyVersion).where(sql`${t.state} IN ('PENDING','APPROVED')`),
  index('stripe_read_policy_change_seq_idx').on(t.seq),
]);

/** Append-only audit of every request transition AND of every change to the policy row itself (including out-of-band owner changes, which carry the database session user and no administrator). */
export const stripeReadPolicyEvents = pgTable('stripe_read_policy_events', {
  seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  changeId: uuid('change_id'),
  version: integer('version').notNull(),
  eventType: text('event_type').$type<'PROPOSED' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'POLICY_ROW_CREATED' | 'POLICY_VALUE_CHANGED'>().notNull(),
  fromState: text('from_state'),
  toState: text('to_state').notNull(),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'restrict' }),
  actorDbRole: text('actor_db_role'),
  decisionRef: text('decision_ref'),
  policyVersion: integer('policy_version').notNull(),
  atMs: bigint('at_ms', { mode: 'number' }).notNull(),
  recordDigest: text('record_digest').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  foreignKey({ name: 'stripe_read_policy_events_change_fk', columns: [t.changeId], foreignColumns: [stripeReadPolicyChanges.id] }).onDelete('restrict'),
  check('stripe_read_policy_events_type_check', sql`${t.eventType} IN ('PROPOSED','APPROVED','REJECTED','CANCELLED','EXPIRED','POLICY_ROW_CREATED','POLICY_VALUE_CHANGED')`),
  check('stripe_read_policy_events_actor_check', sql`(${t.changeId} IS NOT NULL AND ${t.actorId} IS NOT NULL) OR (${t.changeId} IS NULL AND ${t.actorDbRole} IS NOT NULL)`),
  check('stripe_read_policy_events_digest_check', sql`${t.recordDigest} ~ '^[0-9a-f]{64}$' AND ${t.version} >= 1 AND ${t.policyVersion} >= 1`),
  index('stripe_read_policy_events_change_idx').on(t.changeId, t.seq),
]);
