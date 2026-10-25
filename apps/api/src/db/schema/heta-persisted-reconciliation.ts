import { pgTable, uuid, text, integer, timestamp, jsonb, unique, uniqueIndex, index, check, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { stripeProviderEvents } from './stripe-evidence';

/**
 * HETA Block G persisted foundations (migration 0051): durable reconciliation work (G5), immutable cross-provenance comparison results (G2) and
 * append-only bitemporal revisions (G4). Evidence-consistency records only: nothing here attributes an event to a tenant, certifies history, grants an
 * attestation or authorizes anything financial, and nothing in the application writes them yet. `stripe_provider_events` is not altered.
 */

/** G5: a leased work queue with fencing tokens so a crashed or stalled worker can never complete work another worker now holds. */
export const hetaReconciliationWork = pgTable('heta_reconciliation_work', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').$type<'compare_provenance' | 'retrieve_event' | 'reconcile_window'>().notNull(),
  subjectKey: text('subject_key').notNull(),
  dedupeKey: text('dedupe_key').notNull().unique(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  state: text('state').$type<'pending' | 'leased' | 'done' | 'dead'>().notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  leaseToken: uuid('lease_token'),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  notBefore: timestamp('not_before', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  /** Redacted machine code only; never a provider message or payload. */
  lastErrorCode: text('last_error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, t => [
  index('heta_reconciliation_work_claim_idx').on(t.state, t.notBefore),
  index('heta_reconciliation_work_lease_idx').on(t.state, t.leaseExpiresAt),
  check('heta_reconciliation_work_kind_check', sql`${t.kind} IN ('compare_provenance','retrieve_event','reconcile_window')`),
  check('heta_reconciliation_work_state_check', sql`${t.state} IN ('pending','leased','done','dead')`),
  check('heta_reconciliation_work_attempts_check', sql`${t.attempts} >= 0 AND ${t.maxAttempts} BETWEEN 1 AND 20 AND ${t.attempts} <= ${t.maxAttempts}`),
  check('heta_reconciliation_work_payload_check', sql`jsonb_typeof(${t.payload}) = 'object' AND pg_column_size(${t.payload}) <= 4096`),
  check('heta_reconciliation_work_subject_check', sql`char_length(${t.subjectKey}) BETWEEN 1 AND 300 AND char_length(${t.dedupeKey}) BETWEEN 1 AND 400`),
  check('heta_reconciliation_work_error_code_check', sql`${t.lastErrorCode} IS NULL OR ${t.lastErrorCode} ~ '^[a-z0-9_]{1,64}$'`),
  check('heta_reconciliation_work_shape_check', sql`(${t.state} = 'leased') = (${t.leaseToken} IS NOT NULL AND ${t.leaseOwner} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)
    AND ((${t.state} IN ('done','dead')) = (${t.completedAt} IS NOT NULL))
    AND (${t.state} <> 'dead' OR ${t.lastErrorCode} IS NOT NULL)`),
]);

/**
 * G2: immutable typed comparison of an authenticated webhook receipt with an independently retrieved receipt of the SAME event identity
 * (a trigger verifies identity equality and the two provenances). Dispositions never imply authority; arrival order is not recorded as evidence.
 */
export const hetaProvenanceComparisons = pgTable('heta_provenance_comparisons', {
  id: uuid('id').primaryKey().defaultRandom(),
  webhookRecordId: uuid('webhook_record_id').notNull().references(() => stripeProviderEvents.id, { onDelete: 'restrict' }),
  retrievedRecordId: uuid('retrieved_record_id').references(() => stripeProviderEvents.id, { onDelete: 'restrict' }),
  disposition: text('disposition').$type<'corroborated_fields' | 'conflicted' | 'incomparable' | 'unassessed'>().notNull(),
  mismatches: jsonb('mismatches').$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
  reasons: jsonb('reasons').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  ruleVersion: text('rule_version').notNull(),
  comparedAt: timestamp('compared_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  uniqueIndex('heta_provenance_comparisons_pair_uq').on(t.webhookRecordId, t.retrievedRecordId, t.ruleVersion).where(sql`${t.retrievedRecordId} IS NOT NULL`),
  uniqueIndex('heta_provenance_comparisons_unassessed_uq').on(t.webhookRecordId, t.ruleVersion).where(sql`${t.retrievedRecordId} IS NULL`),
  index('heta_provenance_comparisons_webhook_idx').on(t.webhookRecordId, t.comparedAt),
  check('heta_provenance_comparisons_disposition_check', sql`${t.disposition} IN ('corroborated_fields','conflicted','incomparable','unassessed')`),
  check('heta_provenance_comparisons_arrays_check', sql`jsonb_typeof(${t.mismatches}) = 'array' AND jsonb_typeof(${t.reasons}) = 'array'`),
  check('heta_provenance_comparisons_rule_check', sql`char_length(${t.ruleVersion}) BETWEEN 1 AND 100`),
  check('heta_provenance_comparisons_shape_check', sql`(${t.disposition} = 'corroborated_fields' AND ${t.retrievedRecordId} IS NOT NULL AND jsonb_array_length(${t.mismatches}) = 0 AND jsonb_array_length(${t.reasons}) = 0)
    OR (${t.disposition} = 'conflicted' AND ${t.retrievedRecordId} IS NOT NULL AND jsonb_array_length(${t.mismatches}) > 0)
    OR (${t.disposition} = 'incomparable' AND ${t.retrievedRecordId} IS NOT NULL AND jsonb_array_length(${t.reasons}) > 0)
    OR (${t.disposition} = 'unassessed' AND ${t.retrievedRecordId} IS NULL AND jsonb_array_length(${t.mismatches}) = 0)`),
]);

/** G4: append-only bitemporal revisions. The database makes a fork impossible and enforces the chain rules; the service adds expected-predecessor checks. */
export const hetaRecordRevisions = pgTable('heta_record_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  scopeKey: text('scope_key').notNull(),
  revision: integer('revision').notNull(),
  supersedes: uuid('supersedes'),
  state: text('state').$type<'active' | 'revoked' | 'compromised'>().notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  recoveryRef: text('recovery_ref'),
  /** What this revision is about (for example an attestation control-event id). Reference only. */
  subjectRef: text('subject_ref'),
}, t => [
  unique('heta_record_revisions_scope_revision_key').on(t.scopeKey, t.revision),
  unique('heta_record_revisions_id_scope_key').on(t.id, t.scopeKey),
  uniqueIndex('heta_record_revisions_successor_key').on(t.supersedes).where(sql`${t.supersedes} IS NOT NULL`),
  foreignKey({ name: 'heta_record_revisions_supersedes_fk', columns: [t.supersedes, t.scopeKey], foreignColumns: [t.id, t.scopeKey] }).onDelete('restrict'),
  check('heta_record_revisions_state_check', sql`${t.state} IN ('active','revoked','compromised')`),
  check('heta_record_revisions_first_check', sql`(${t.revision} = 1) = (${t.supersedes} IS NULL) AND ${t.revision} >= 1`),
  check('heta_record_revisions_scope_check', sql`char_length(${t.scopeKey}) BETWEEN 1 AND 300`),
]);

