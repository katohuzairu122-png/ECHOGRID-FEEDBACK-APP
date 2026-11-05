import { pgTable, uuid, text, bigint, integer, timestamp, unique, check, foreignKey, index, uniqueIndex, boolean } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { users } from './users';

/**
 * S08-D1D3-DEV-10: DURABLE Stripe read authorization (migration 0062). DEVELOPMENT ONLY and inert: no route, queue or cron writes here, and the approval write path is disabled by default
 * (`stripe_read_authorization_policy.approval_enabled = false`).
 *
 * One row authorizes ONE read method for ONE business, Stripe test account and trusted workload, for a validity period. It is a proposal (PENDING), an approval (APPROVED) or a revocation
 * (REVOKED, terminal). Rows are never deleted and an expired approval is never renewed: a new authorization is a NEW row. Every transition is written to the append-only event table by
 * a trigger, and the lifecycle (who may approve, self-approval, transitions, expiry, the disabled-by-default switch) is enforced by triggers, so a direct SQL write cannot skip it.
 * The database never decides WHICH methods Stripe may be asked for: the closed capability registry in the API does, and a row for a method the registry has no transport path for
 * authorizes nothing.
 */
export const stripeReadAuthorizations = pgTable('stripe_read_authorizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
  accountId: text('account_id').notNull(),
  realm: text('realm').notNull(),
  workloadId: text('workload_id').notNull(),
  methodId: text('method_id').notNull(),
  state: text('state').$type<'PENDING' | 'APPROVED' | 'REVOKED'>().notNull(),
  version: integer('version').notNull().default(1),
  validFromMs: bigint('valid_from_ms', { mode: 'number' }).notNull(),
  expiresAtMs: bigint('expires_at_ms', { mode: 'number' }).notNull(),
  inventoryRecordId: text('inventory_record_id').notNull(),
  inventoryRevision: text('inventory_revision').notNull(),
  proposedBy: uuid('proposed_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'restrict' }),
  approvedAtMs: bigint('approved_at_ms', { mode: 'number' }),
  approvalEvidenceRef: text('approval_evidence_ref'),
  revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'restrict' }),
  revokedAtMs: bigint('revoked_at_ms', { mode: 'number' }),
  revokeReason: text('revoke_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  check('stripe_read_auth_realm_check', sql`${t.realm} = 'test'`),
  check('stripe_read_auth_method_check', sql`${t.methodId} IN ('ACCOUNT_RETRIEVE_CURRENT','INVOICE_RETRIEVE','INVOICE_LINES_LIST','PAYMENT_RETRIEVE','REFUNDS_LIST','DISPUTES_LIST')`),
  check('stripe_read_auth_state_check', sql`${t.state} IN ('PENDING','APPROVED','REVOKED')`),
  check('stripe_read_auth_refs_check', sql`${t.accountId} ~ '^acct_[A-Za-z0-9]{1,128}$' AND ${t.workloadId} ~ '^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$' AND ${t.inventoryRecordId} ~ '^[!-~]{1,255}$' AND ${t.inventoryRevision} ~ '^[!-~]{1,255}$'`),
  check('stripe_read_auth_window_check', sql`${t.validFromMs} >= 0 AND ${t.expiresAtMs} > ${t.validFromMs}`),
  check('stripe_read_auth_version_check', sql`${t.version} >= 1`),
  check('stripe_read_auth_state_fields_check', sql`(${t.state} = 'PENDING' AND ${t.approvedBy} IS NULL AND ${t.approvedAtMs} IS NULL AND ${t.approvalEvidenceRef} IS NULL AND ${t.revokedBy} IS NULL AND ${t.revokedAtMs} IS NULL AND ${t.revokeReason} IS NULL)
    OR (${t.state} = 'APPROVED' AND ${t.approvedBy} IS NOT NULL AND ${t.approvedAtMs} IS NOT NULL AND ${t.approvalEvidenceRef} IS NOT NULL AND ${t.approvalEvidenceRef} ~ '^[!-~]{1,255}$' AND ${t.revokedBy} IS NULL AND ${t.revokedAtMs} IS NULL AND ${t.revokeReason} IS NULL)
    OR (${t.state} = 'REVOKED' AND ${t.revokedBy} IS NOT NULL AND ${t.revokedAtMs} IS NOT NULL AND ${t.revokeReason} IS NOT NULL AND ${t.revokeReason} ~ '^[A-Z_]{1,64}$' AND (${t.approvedBy} IS NULL) = (${t.approvedAtMs} IS NULL) AND (${t.approvedBy} IS NULL) = (${t.approvalEvidenceRef} IS NULL))`),
  // at most ONE live (pending or approved) authorization per business, account, workload and method: concurrent proposals and approvals cannot create duplicate authority
  uniqueIndex('stripe_read_auth_live_key').on(t.businessId, t.accountId, t.workloadId, t.methodId).where(sql`${t.state} IN ('PENDING','APPROVED')`),
  index('stripe_read_auth_lookup_idx').on(t.businessId, t.methodId),
  unique('stripe_read_auth_id_business_key').on(t.id, t.businessId),
]);

/** Append-only audit of every lifecycle change; written by a trigger, never by a caller. `record_digest` is sha256 over the authorization's fields after the change. */
export const stripeReadAuthorizationEvents = pgTable('stripe_read_authorization_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  authorizationId: uuid('authorization_id').notNull(),
  businessId: uuid('business_id').notNull(),
  version: integer('version').notNull(),
  eventType: text('event_type').$type<'PROPOSED' | 'APPROVED' | 'REVOKED'>().notNull(),
  fromState: text('from_state'),
  toState: text('to_state').notNull(),
  actorId: uuid('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  evidenceRef: text('evidence_ref'),
  atMs: bigint('at_ms', { mode: 'number' }).notNull(),
  recordDigest: text('record_digest').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  foreignKey({ name: 'stripe_read_auth_events_auth_fk', columns: [t.authorizationId, t.businessId], foreignColumns: [stripeReadAuthorizations.id, stripeReadAuthorizations.businessId] }).onDelete('restrict'),
  unique('stripe_read_auth_events_version_key').on(t.authorizationId, t.version),
  check('stripe_read_auth_events_type_check', sql`${t.eventType} IN ('PROPOSED','APPROVED','REVOKED') AND ${t.toState} IN ('PENDING','APPROVED','REVOKED') AND (${t.fromState} IS NULL OR ${t.fromState} IN ('PENDING','APPROVED','REVOKED'))`),
  check('stripe_read_auth_events_digest_check', sql`${t.recordDigest} ~ '^[0-9a-f]{64}$' AND ${t.version} >= 1`),
]);

/** Singleton switch. `approval_enabled` is false by default and no application role may change it: enabling operational approval is an owner decision made out of band. */
export const stripeReadAuthorizationPolicy = pgTable('stripe_read_authorization_policy', {
  singleton: boolean('singleton').primaryKey().default(true),
  approvalEnabled: boolean('approval_enabled').notNull().default(false),
}, t => [check('stripe_read_auth_policy_singleton_check', sql`${t.singleton} = true`)]);
