import { pgTable, uuid, text, bigint, integer, timestamp, check, foreignKey, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';

/**
 * S08-D1D3-DEV-15: durable, tamper-evident CUSTODY of signed evidence produced by the DEV-14 signing boundary (migration 0065). DEVELOPMENT ONLY and inert.
 *
 * A record stores the EXACT signed representation (claims as columns, the canonical payload text that was hashed, and the signature) and is immutable: it is inserted only by the custody-writing definer function
 * after the trusted service has verified the DEV-14 envelope, and can never be updated, deleted or truncated. A database digest or RLS policy is NOT cryptographic proof of provider authenticity: retrieval
 * re-verifies the signature against the public-key directory every time. Custody events are append-only facts about what happened to a record (persisted, replayed, verified, denied).
 * Nothing here grants financial authorization, touches the read-authorization policy, or reaches Stripe.
 */
export const signedEvidenceRecords = pgTable('signed_evidence_records', {
  evidenceId: uuid('evidence_id').primaryKey(),
  seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
  custodianWorkloadId: text('custodian_workload_id').notNull(),
  signerWorkloadId: text('signer_workload_id').notNull(),
  environment: text('environment').notNull(),
  purpose: text('purpose').notNull(),
  evidenceType: text('evidence_type').notNull(),
  schema: text('schema').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  signedAtMs: bigint('signed_at_ms', { mode: 'number' }).notNull(),
  keyId: text('key_id').notNull(),
  keyVersion: integer('key_version').notNull(),
  algorithm: text('algorithm').notNull(),
  payloadSha256: text('payload_sha256').notNull(),
  signature: text('signature').notNull(),
  payloadCanonical: text('payload_canonical').notNull(),
  contentDigest: text('content_digest').notNull(),
  version: integer('version').notNull().default(1),
  persistedByDbRole: text('persisted_by_db_role').notNull(),
  createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  uniqueIndex('signed_evidence_records_signature_key').on(t.signature),
  uniqueIndex('signed_evidence_records_seq_key').on(t.seq),
  index('signed_evidence_records_business_idx').on(t.businessId, t.seq),
  check('signed_evidence_records_env_check', sql`${t.environment} IN ('development','staging','production')`),
  check('signed_evidence_records_purpose_check', sql`(${t.purpose} = 'STRIPE_OBSERVATION_ATTESTATION' AND ${t.evidenceType} IN ('STRIPE_ACCOUNT_OBSERVATION','STRIPE_INVOICE_OBSERVATION'))
    OR (${t.purpose} = 'SYNTHETIC_TEST_EVIDENCE' AND ${t.evidenceType} = 'SYNTHETIC_TEST_EVIDENCE' AND ${t.environment} <> 'production')`),
  check('signed_evidence_records_schema_check', sql`${t.schema} = 'S08-SIGNED-EVIDENCE' AND ${t.schemaVersion} = 1 AND ${t.algorithm} = 'Ed25519' AND ${t.version} = 1`),
  check('signed_evidence_records_format_check', sql`${t.payloadSha256} ~ '^[0-9a-f]{64}$' AND ${t.signature} ~ '^[0-9a-f]{128}$' AND ${t.contentDigest} ~ '^[0-9a-f]{64}$'
    AND ${t.keyId} ~ '^[A-Za-z0-9._-]{1,64}$' AND ${t.keyVersion} >= 1 AND ${t.signedAtMs} >= 0 AND ${t.createdAtMs} > 0
    AND ${t.custodianWorkloadId} ~ '^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$' AND ${t.signerWorkloadId} ~ '^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$'`),
  // the stored canonical payload is exactly what was hashed: the database refuses a record whose payload and digest disagree
  check('signed_evidence_records_payload_check', sql`octet_length(${t.payloadCanonical}) BETWEEN 2 AND 65536 AND encode(sha256(convert_to(${t.payloadCanonical}, 'UTF8')), 'hex') = ${t.payloadSha256}`),
]);

/** Append-only custody events. `evidence_id` is null only for access denials that name no stored record; every event names the tenant it concerns. */
export const signedEvidenceEvents = pgTable('signed_evidence_events', {
  seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  evidenceId: uuid('evidence_id'),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
  eventType: text('event_type').notNull(),
  reasonCode: text('reason_code').notNull(),
  actorWorkloadId: text('actor_workload_id'),
  actorDbRole: text('actor_db_role').notNull(),
  atMs: bigint('at_ms', { mode: 'number' }).notNull(),
  recordDigest: text('record_digest').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  foreignKey({ name: 'signed_evidence_events_evidence_fk', columns: [t.evidenceId], foreignColumns: [signedEvidenceRecords.evidenceId] }).onDelete('restrict'),
  check('signed_evidence_events_type_check', sql`${t.eventType} IN ('EVIDENCE_PERSISTED','EVIDENCE_REPLAYED','EVIDENCE_CONFLICT_REJECTED','VERIFICATION_ATTEMPTED','VERIFICATION_SUCCEEDED','VERIFICATION_FAILED','KEY_UNAVAILABLE','KEY_REVOKED','ACCESS_DENIED')`),
  check('signed_evidence_events_format_check', sql`${t.reasonCode} ~ '^[A-Z0-9_]{1,64}$' AND ${t.recordDigest} ~ '^[0-9a-f]{64}$' AND ${t.atMs} > 0
    AND (${t.actorWorkloadId} IS NULL OR ${t.actorWorkloadId} ~ '^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$')`),
  index('signed_evidence_events_evidence_idx').on(t.evidenceId, t.seq),
  index('signed_evidence_events_business_idx').on(t.businessId, t.seq),
  index('signed_evidence_events_dedupe_idx').on(t.evidenceId, t.eventType, t.reasonCode, t.actorWorkloadId, t.atMs),
]);
