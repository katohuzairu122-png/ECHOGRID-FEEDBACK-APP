import { pgTable, uuid, text, integer, timestamp, check, unique, foreignKey, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { partnerCreditSettlementAuthorizations } from './partner-credit-settlement-authorizations';
import { signedEvidenceRecords } from './signed-evidence-custody';

/**
 * DEV-20.B: inert, append-only custody-to-authorization reference.
 * Actual custody Ed25519 signature and content digest are held immutably
 * in signed_evidence_records, addressed by a composite key including tenant,
 * payload digest and signing key/version. Never an independent financial grant.
 */
export const settlementCustodyAuthorizationLinks = pgTable('settlement_custody_authorization_links', {
  authorizationId: uuid('authorization_id').primaryKey().notNull(),
  evidenceId: uuid('evidence_id').notNull(),
  businessId: uuid('business_id').notNull(),
  reservationId: uuid('reservation_id').notNull(),
  payloadSha256: text('payload_sha256').notNull(),
  custodyKeyId: text('custody_key_id').notNull(),
  custodyKeyVersion: integer('custody_key_version').notNull(),
  authorizationEvidenceDigest: text('authorization_evidence_digest').notNull(),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  unique('settlement_custody_link_one_evidence').on(t.evidenceId),
  index('settlement_custody_link_business_idx').on(t.businessId, t.reservationId),
  foreignKey({
    name: 'settlement_custody_link_auth_fk',
    columns: [t.authorizationId, t.businessId, t.reservationId, t.authorizationEvidenceDigest],
    foreignColumns: [partnerCreditSettlementAuthorizations.id, partnerCreditSettlementAuthorizations.businessId, partnerCreditSettlementAuthorizations.reservationId, partnerCreditSettlementAuthorizations.evidenceDigest],
  }).onDelete('restrict'),
  foreignKey({
    name: 'settlement_custody_link_custody_fk',
    columns: [t.evidenceId, t.businessId, t.payloadSha256, t.custodyKeyId, t.custodyKeyVersion],
    foreignColumns: [signedEvidenceRecords.evidenceId, signedEvidenceRecords.businessId, signedEvidenceRecords.payloadSha256, signedEvidenceRecords.keyId, signedEvidenceRecords.keyVersion],
  }).onDelete('restrict'),
  check('settlement_custody_link_hash_check', sql`${t.payloadSha256} ~ '^[0-9a-f]{64}$' AND ${t.authorizationEvidenceDigest} ~ '^[0-9a-f]{64}$'`),
  check('settlement_custody_link_key_check', sql`${t.custodyKeyId} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' AND ${t.custodyKeyVersion} >= 1`),
]);
