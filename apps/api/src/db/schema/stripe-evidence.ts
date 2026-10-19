import {
  pgTable, uuid, text, timestamp, jsonb, boolean, bigint, integer, index, uniqueIndex, unique, check, foreignKey, customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';

/**
 * HETA-01-F1 (migration 0045): append-only Stripe provider-event evidence.
 * Evidence capture only. No attribution, no projection change, no economic table reference.
 * `provider_created_at` is NEVER an effective-time claim. Append-only triggers are hand-appended
 * in the migration SQL (tamper-evident, not tamper-proof). See HETA-01-F1 design A.1-A.7.
 */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return 'bytea';
  },
});

const ts = (name: string) => timestamp(name, { withTimezone: true });
const ACCT = `'^acct_[A-Za-z0-9]+$'`;

/** A.5 append-only control and coverage log. No FK to the other evidence tables (no cycle). */
export const stripeEvidenceControlEvents = pgTable('stripe_evidence_control_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
  eventKind: text('event_kind').notNull(),
  occurredAt: ts('occurred_at').notNull().default(sql`clock_timestamp()`),
  stream: text('stream'),
  cause: text('cause'),
  dedupeKey: text('dedupe_key'),
  windowStart: ts('window_start'),
  windowEnd: ts('window_end'),
  actor: text('actor').notNull(),
  commitSha: text('commit_sha'),
  approvalRef: text('approval_ref'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
}, t => [
  uniqueIndex('stripe_evidence_control_dedupe_key_uq').on(t.dedupeKey),
  index('stripe_evidence_control_stream_kind_seq_idx').on(t.stream, t.eventKind, t.seq.desc()),
  check('stripe_evidence_control_kind_check', sql`${t.eventKind} IN ('account_provenance_verified','capture_mode_changed','capture_heartbeat','heartbeat_gap_detected','capture_precondition_failed','capture_error_observed','oversize_rejected','reconciliation_run','coverage_gap_unrecovered','ucw_opened','ucw_closed','kek_generated','kek_rotated','kek_destroyed','retention_policy_applied','legal_hold_set','legal_hold_released','forensic_export_registered','forensic_export_destroyed')`),
  check('stripe_evidence_control_details_check', sql`jsonb_typeof(${t.details}) = 'object' AND pg_column_size(${t.details}) <= 8192`),
  check('stripe_evidence_control_stream_dedupe_required', sql`${t.eventKind} NOT IN ('capture_heartbeat','heartbeat_gap_detected','capture_precondition_failed','capture_error_observed','oversize_rejected','ucw_opened','ucw_closed') OR (${t.stream} IS NOT NULL AND ${t.dedupeKey} IS NOT NULL)`),
  check('stripe_evidence_control_cause_required', sql`${t.eventKind} NOT IN ('ucw_opened','ucw_closed','heartbeat_gap_detected') OR COALESCE(${t.cause} IN ('capture_off','precondition_failed','http_413','http_500','heartbeat_gap','oversize_unresolved','reconciliation_incomplete','unrecorded_mode_change'), false)`),
  check('stripe_evidence_control_attestation_result', sql`${t.eventKind} <> 'account_provenance_verified' OR COALESCE(${t.details}->>'result' IN ('passed','failed'), false)`),
  check('stripe_evidence_control_kek_destroyed_claim', sql`${t.eventKind} <> 'kek_destroyed' OR COALESCE((${t.details}->>'claim' = 'conditional') OR (${t.details}->>'claim' = 'irrecoverable_verified' AND jsonb_typeof(${t.details}->'evidence') = 'object' AND ${t.details}->'evidence'->>'e1_custody_inventory' = 'true' AND ${t.details}->'evidence'->>'e2_two_person_attestation' = 'true' AND ${t.details}->'evidence'->>'e3_platform_evidence' = 'true' AND ${t.details}->'evidence'->>'e4_independent_signoff' = 'true' AND ${t.details}->'evidence'->>'e5_negative_tests_run' = 'true' AND jsonb_typeof(${t.details}->'evidence_refs') = 'array' AND jsonb_array_length(${t.details}->'evidence_refs') > 0), false)`),
]);

/** A.6 wrapped data keys. Append-only; destruction acts on KEKs outside the database. */
export const stripeEvidenceKeys = pgTable('stripe_evidence_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  cohort: text('cohort').notNull(),
  kekVersion: text('kek_version').notNull(),
  wrappedDek: bytea('wrapped_dek').notNull(),
  wrapNonce: bytea('wrap_nonce').notNull(),
  wrapAlgorithm: text('wrap_algorithm').notNull(),
  dekFingerprint: bytea('dek_fingerprint').notNull(),
  createdAt: ts('created_at').notNull().default(sql`clock_timestamp()`),
}, t => [
  // A constraint (not an index) so it exists inside CREATE TABLE, before the composite FKs that reference it.
  unique('stripe_evidence_keys_cohort_kek_uq').on(t.cohort, t.kekVersion),
  check('stripe_evidence_keys_cohort_check', sql`${t.cohort} ~ '^[0-9]{4}-(0[1-9]|1[0-2])(:[a-z0-9_]+)?$'`),
  check('stripe_evidence_keys_algorithm_check', sql`${t.wrapAlgorithm} = 'AES-256-GCM'`),
]);

/** A.2 evidence inbox for well-formed envelopes. No business_id. */
export const stripeProviderEvents = pgTable('stripe_provider_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  receivingAccountId: text('receiving_account_id').notNull(),
  eventAccountId: text('event_account_id').notNull(),
  accountScope: text('account_scope').notNull(),
  livemode: boolean('livemode').notNull(),
  stripeEventId: text('stripe_event_id').notNull(),
  provenance: text('provenance').notNull(),
  attestationEventId: uuid('attestation_event_id').notNull().references(() => stripeEvidenceControlEvents.id, { onDelete: 'restrict' }),
  eventType: text('event_type').notNull(),
  apiVersion: text('api_version'),
  providerCreatedUnix: bigint('provider_created_unix', { mode: 'number' }).notNull(),
  providerCreatedAt: ts('provider_created_at').notNull(),
  receivedAt: ts('received_at').notNull(),
  committedAt: ts('committed_at').notNull().default(sql`clock_timestamp()`),
  payloadSha256: bytea('payload_sha256').notNull(),
  payloadCiphertext: bytea('payload_ciphertext').notNull(),
  payloadNonce: bytea('payload_nonce').notNull(),
  payloadKeyCohort: text('payload_key_cohort').notNull(),
  kekVersion: text('kek_version').notNull(),
  payloadBytes: integer('payload_bytes').notNull(),
  sigHeaderTimestamp: bigint('sig_header_timestamp', { mode: 'number' }),
  sigScheme: text('sig_scheme'),
  signingSecretLabel: text('signing_secret_label'),
  verifiedAt: ts('verified_at'),
  verifierVersion: text('verifier_version'),
  retrievedAt: ts('retrieved_at'),
  retrievalRunId: uuid('retrieval_run_id').references(() => stripeEvidenceControlEvents.id, { onDelete: 'restrict' }),
  retrievalApiVersion: text('retrieval_api_version'),
  stripeRequestId: text('stripe_request_id'),
  stripeIdempotencyKey: text('stripe_idempotency_key'),
  objectType: text('object_type'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  stripeCustomerId: text('stripe_customer_id'),
  claimedBusinessId: text('claimed_business_id'),
  captureMode: text('capture_mode').notNull(),
  projectionMode: text('projection_mode').notNull(),
  retentionPolicyVersion: text('retention_policy_version').notNull(),
  retainUntil: ts('retain_until').notNull(),
}, t => [
  foreignKey({ name: 'stripe_provider_events_key_fk', columns: [t.payloadKeyCohort, t.kekVersion], foreignColumns: [stripeEvidenceKeys.cohort, stripeEvidenceKeys.kekVersion] }).onDelete('restrict'),
  uniqueIndex('stripe_provider_events_identity_uq').on(t.receivingAccountId, t.eventAccountId, t.livemode, t.stripeEventId, t.provenance),
  index('stripe_provider_events_subscription_created_idx').on(t.stripeSubscriptionId, t.providerCreatedAt),
  index('stripe_provider_events_received_at_idx').on(t.receivedAt),
  index('stripe_provider_events_customer_idx').on(t.stripeCustomerId),
  check('stripe_provider_events_receiving_acct_check', sql`${t.receivingAccountId} ~ ${sql.raw(ACCT)}`),
  check('stripe_provider_events_event_acct_check', sql`${t.eventAccountId} ~ ${sql.raw(ACCT)}`),
  check('stripe_provider_events_scope_check', sql`(${t.accountScope} = 'direct' AND ${t.eventAccountId} = ${t.receivingAccountId}) OR (${t.accountScope} = 'connect' AND ${t.eventAccountId} <> ${t.receivingAccountId})`),
  check('stripe_provider_events_event_id_check', sql`${t.stripeEventId} ~ '^evt_[A-Za-z0-9_]+$'`),
  check('stripe_provider_events_provenance_check', sql`${t.provenance} IN ('webhook_signature','api_retrieval')`),
  check('stripe_provider_events_created_check', sql`${t.providerCreatedAt} = to_timestamp(${t.providerCreatedUnix})`),
  check('stripe_provider_events_digest_check', sql`octet_length(${t.payloadSha256}) = 32`),
  check('stripe_provider_events_nonce_check', sql`octet_length(${t.payloadNonce}) = 12`),
  check('stripe_provider_events_bytes_check', sql`${t.payloadBytes} > 0 AND ${t.payloadBytes} <= 16777216`),
  check('stripe_provider_events_sig_scheme_check', sql`${t.sigScheme} IS NULL OR ${t.sigScheme} = 'v1'`),
  check('stripe_provider_events_provenance_groups_check', sql`(${t.provenance} = 'webhook_signature' AND ${t.sigHeaderTimestamp} IS NOT NULL AND ${t.sigScheme} IS NOT NULL AND ${t.signingSecretLabel} IS NOT NULL AND ${t.verifiedAt} IS NOT NULL AND ${t.verifierVersion} IS NOT NULL AND ${t.retrievedAt} IS NULL AND ${t.retrievalRunId} IS NULL AND ${t.retrievalApiVersion} IS NULL) OR (${t.provenance} = 'api_retrieval' AND ${t.retrievedAt} IS NOT NULL AND ${t.retrievalRunId} IS NOT NULL AND ${t.retrievalApiVersion} IS NOT NULL AND ${t.sigHeaderTimestamp} IS NULL AND ${t.sigScheme} IS NULL AND ${t.signingSecretLabel} IS NULL AND ${t.verifiedAt} IS NULL AND ${t.verifierVersion} IS NULL)`),
  check('stripe_provider_events_capture_mode_check', sql`${t.captureMode} = 'enforced'`),
  check('stripe_provider_events_projection_mode_check', sql`${t.projectionMode} = 'legacy'`),
]);

/** A.2b authenticated bodies that are not well-formed envelopes; the row is its own quarantine record. */
export const stripeProviderMalformedReceipts = pgTable('stripe_provider_malformed_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  receivedAt: ts('received_at').notNull(),
  committedAt: ts('committed_at').notNull().default(sql`clock_timestamp()`),
  payloadSha256: bytea('payload_sha256').notNull(),
  payloadCiphertext: bytea('payload_ciphertext').notNull(),
  payloadNonce: bytea('payload_nonce').notNull(),
  payloadKeyCohort: text('payload_key_cohort').notNull(),
  kekVersion: text('kek_version').notNull(),
  payloadBytes: integer('payload_bytes').notNull(),
  sigHeaderTimestamp: bigint('sig_header_timestamp', { mode: 'number' }).notNull(),
  sigScheme: text('sig_scheme').notNull(),
  signingSecretLabel: text('signing_secret_label').notNull(),
  verifiedAt: ts('verified_at').notNull(),
  verifierVersion: text('verifier_version').notNull(),
  parseStatus: text('parse_status').notNull(),
  shapeDefects: text('shape_defects').array().notNull(),
  reasonCodes: text('reason_codes').array().notNull(),
  receivingAccountId: text('receiving_account_id').notNull(),
  attestationEventId: uuid('attestation_event_id').notNull().references(() => stripeEvidenceControlEvents.id, { onDelete: 'restrict' }),
  captureMode: text('capture_mode').notNull(),
  projectionMode: text('projection_mode').notNull(),
  retentionPolicyVersion: text('retention_policy_version').notNull(),
  retainUntil: ts('retain_until').notNull(),
}, t => [
  foreignKey({ name: 'stripe_provider_malformed_receipts_key_fk', columns: [t.payloadKeyCohort, t.kekVersion], foreignColumns: [stripeEvidenceKeys.cohort, stripeEvidenceKeys.kekVersion] }).onDelete('restrict'),
  uniqueIndex('stripe_provider_malformed_receipts_digest_uq').on(t.payloadSha256),
  index('stripe_provider_malformed_receipts_received_at_idx').on(t.receivedAt),
  check('stripe_provider_malformed_receipts_digest_check', sql`octet_length(${t.payloadSha256}) = 32`),
  check('stripe_provider_malformed_receipts_nonce_check', sql`octet_length(${t.payloadNonce}) = 12`),
  check('stripe_provider_malformed_receipts_bytes_check', sql`${t.payloadBytes} > 0 AND ${t.payloadBytes} <= 16777216`),
  check('stripe_provider_malformed_receipts_sig_scheme_check', sql`${t.sigScheme} = 'v1'`),
  check('stripe_provider_malformed_receipts_parse_status_check', sql`${t.parseStatus} IN ('not_json','json_non_object','json_object_invalid_envelope')`),
  check('stripe_provider_malformed_receipts_defects_check', sql`cardinality(${t.shapeDefects}) > 0 AND ${t.shapeDefects} <@ ARRAY['missing_id','bad_id','missing_created','bad_created','missing_livemode','bad_livemode','missing_type','bad_type','missing_data_object','bad_data_object']::text[]`),
  check('stripe_provider_malformed_receipts_reason_check', sql`'QR_SHAPE_INVALID' = ANY(${t.reasonCodes})`),
  check('stripe_provider_malformed_receipts_acct_check', sql`${t.receivingAccountId} ~ ${sql.raw(ACCT)}`),
  check('stripe_provider_malformed_receipts_capture_mode_check', sql`${t.captureMode} = 'enforced'`),
  check('stripe_provider_malformed_receipts_projection_mode_check', sql`${t.projectionMode} = 'legacy'`),
]);

/** A.3 append-only decision and processing log. business_id is never set in F1. */
export const stripeProviderEventDispositions = pgTable('stripe_provider_event_dispositions', {
  id: uuid('id').primaryKey().defaultRandom(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
  eventRecordId: uuid('event_record_id').notNull().references(() => stripeProviderEvents.id, { onDelete: 'restrict' }),
  disposition: text('disposition').notNull(),
  reasonCodes: text('reason_codes').array().notNull().default(sql`'{}'::text[]`),
  actor: text('actor').notNull(),
  ruleVersion: text('rule_version').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  createdAt: ts('created_at').notNull().default(sql`clock_timestamp()`),
  businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'restrict' }),
  attemptNo: integer('attempt_no'),
  claimant: text('claimant'),
  leaseExpiresAt: ts('lease_expires_at'),
}, t => [
  index('stripe_provider_event_dispositions_event_seq_idx').on(t.eventRecordId, t.seq.desc()),
  uniqueIndex('stripe_provider_event_dispositions_claim_uq').on(t.eventRecordId, t.attemptNo).where(sql`${t.disposition} = 'processing_claimed'`),
  check('stripe_provider_event_dispositions_kind_check', sql`${t.disposition} IN ('capture_committed','processing_claimed','quarantined','out_of_scope_type','eligible_for_projection','projection_applied','projection_failed','projection_skipped','provider_corroborated','reconciliation_confirmed','recovered_during_uncertified_window')`),
  check('stripe_provider_event_dispositions_claim_fields_check', sql`${t.disposition} <> 'processing_claimed' OR (${t.attemptNo} IS NOT NULL AND ${t.claimant} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)`),
]);

/** A.4 second delivery with a different body, or cross-provenance field mismatch. */
export const stripeProviderEventConflicts = pgTable('stripe_provider_event_conflicts', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventRecordId: uuid('event_record_id').notNull().references(() => stripeProviderEvents.id, { onDelete: 'restrict' }),
  conflictKind: text('conflict_kind').notNull(),
  conflictingProvenance: text('conflicting_provenance').notNull(),
  conflictingSha256: bytea('conflicting_sha256').notNull(),
  payloadCiphertext: bytea('payload_ciphertext').notNull(),
  payloadNonce: bytea('payload_nonce').notNull(),
  payloadKeyCohort: text('payload_key_cohort').notNull(),
  kekVersion: text('kek_version').notNull(),
  sigHeaderTimestamp: bigint('sig_header_timestamp', { mode: 'number' }),
  sigScheme: text('sig_scheme'),
  signingSecretLabel: text('signing_secret_label'),
  verifiedAt: ts('verified_at'),
  verifierVersion: text('verifier_version'),
  retrievedAt: ts('retrieved_at'),
  retrievalRunId: uuid('retrieval_run_id').references(() => stripeEvidenceControlEvents.id, { onDelete: 'restrict' }),
  retrievalApiVersion: text('retrieval_api_version'),
  detectedAt: ts('detected_at').notNull().default(sql`clock_timestamp()`),
}, t => [
  foreignKey({ name: 'stripe_provider_event_conflicts_key_fk', columns: [t.payloadKeyCohort, t.kekVersion], foreignColumns: [stripeEvidenceKeys.cohort, stripeEvidenceKeys.kekVersion] }).onDelete('restrict'),
  uniqueIndex('stripe_provider_event_conflicts_idem_uq').on(t.eventRecordId, t.conflictKind, t.conflictingSha256),
  check('stripe_provider_event_conflicts_kind_check', sql`${t.conflictKind} IN ('webhook_digest_mismatch','provider_field_mismatch')`),
  check('stripe_provider_event_conflicts_provenance_check', sql`${t.conflictingProvenance} IN ('webhook_signature','api_retrieval')`),
  check('stripe_provider_event_conflicts_digest_check', sql`octet_length(${t.conflictingSha256}) = 32`),
  check('stripe_provider_event_conflicts_nonce_check', sql`octet_length(${t.payloadNonce}) = 12`),
  check('stripe_provider_event_conflicts_provenance_groups_check', sql`(${t.conflictingProvenance} = 'webhook_signature' AND ${t.sigHeaderTimestamp} IS NOT NULL AND ${t.sigScheme} = 'v1' AND ${t.signingSecretLabel} IS NOT NULL AND ${t.verifiedAt} IS NOT NULL AND ${t.verifierVersion} IS NOT NULL AND ${t.retrievedAt} IS NULL AND ${t.retrievalRunId} IS NULL AND ${t.retrievalApiVersion} IS NULL) OR (${t.conflictingProvenance} = 'api_retrieval' AND ${t.retrievedAt} IS NOT NULL AND ${t.retrievalRunId} IS NOT NULL AND ${t.retrievalApiVersion} IS NOT NULL AND ${t.sigHeaderTimestamp} IS NULL AND ${t.sigScheme} IS NULL AND ${t.signingSecretLabel} IS NULL AND ${t.verifiedAt} IS NULL AND ${t.verifierVersion} IS NULL)`),
]);
