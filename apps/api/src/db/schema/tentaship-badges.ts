import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex, unique, check, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';
import { businesses } from './businesses';
import { users } from './users';

export const BADGE_PARTICIPANT_TYPES = ['customer', 'business'] as const;
export type BadgeParticipantType = (typeof BADGE_PARTICIPANT_TYPES)[number];
export const BADGE_VERSION_STATUSES = ['draft', 'active', 'retired'] as const;
export type BadgeVersionStatus = (typeof BADGE_VERSION_STATUSES)[number];

/**
 * TB-02 (Tentaship Badges, achievement ledger). Separate from, and never a replacement for, the legacy Community Points tables, business loyalty
 * points and rewards: a badge has no balance, no value, no transfer, no redemption, no cash-out and no Shuffle entitlement (TB-01 D-1/D-2).
 * Canonical identity of a badge. Content lives in immutable versions.
 */
export const tentashipBadgeDefinitions = pgTable(
  'tentaship_badge_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable machine key, e.g. `first_survey`. Immutable. */
    key: text('key').notNull(),
    participantType: text('participant_type').$type<BadgeParticipantType>().notNull(),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tentaship_badge_definitions_key_uq').on(t.key),
    unique('tentaship_badge_definitions_id_participant_uq').on(t.id, t.participantType),
    check('tentaship_badge_definitions_key_format', sql`${t.key} ~ '^[a-z][a-z0-9_]{2,63}$'`),
    check('tentaship_badge_definitions_participant_valid', sql`${t.participantType} IN ('customer','business')`),
  ],
);

/** Versioned, IMMUTABLE content (names, descriptions, qualification rule). A change is a new version. Exactly one version may be active. */
export const tentashipBadgeDefinitionVersions = pgTable(
  'tentaship_badge_definition_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    definitionId: uuid('definition_id').notNull().references(() => tentashipBadgeDefinitions.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    status: text('status').$type<BadgeVersionStatus>().notNull().default('draft'),
    names: jsonb('names').$type<Record<string, string>>().notNull(),
    descriptions: jsonb('descriptions').$type<Record<string, string>>().notNull(),
    /** Declarative, closed-schema qualification rule (see tentaship-badges/badge-rules.ts). Never an expression. */
    rule: jsonb('rule').$type<Record<string, unknown>>().notNull(),
    ruleHash: text('rule_hash').notNull(),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => [
    unique('tentaship_badge_versions_definition_version_uq').on(t.definitionId, t.version),
    unique('tentaship_badge_versions_id_definition_uq').on(t.id, t.definitionId),
    uniqueIndex('tentaship_badge_versions_one_active_idx').on(t.definitionId).where(sql`${t.status} = 'active'`),
    index('tentaship_badge_versions_status_idx').on(t.status, t.definitionId),
    check('tentaship_badge_versions_status_valid', sql`${t.status} IN ('draft','active','retired')`),
    check('tentaship_badge_versions_version_positive', sql`${t.version} >= 1`),
    check('tentaship_badge_versions_hash_format', sql`${t.ruleHash} ~ '^[0-9a-f]{64}$'`),
    check('tentaship_badge_versions_names_en', sql`jsonb_typeof(${t.names}) = 'object' AND ${t.names} ? 'en'`),
    check('tentaship_badge_versions_lifecycle_shape', sql`(${t.status} = 'draft' AND ${t.activatedAt} IS NULL AND ${t.retiredAt} IS NULL) OR (${t.status} = 'active' AND ${t.activatedAt} IS NOT NULL AND ${t.retiredAt} IS NULL) OR (${t.status} = 'retired' AND ${t.retiredAt} IS NOT NULL)`),
  ],
);

/**
 * The award ledger: APPEND-ONLY. One row = one badge earned by one participant under one definition version, with the verified evidence that
 * justified it. No balance, no amount. Duplicate awards are impossible: one award per (definition, participant) and one per (definition,
 * evidence) are database constraints, so replays and concurrent evaluations collapse to the first insert.
 */
export const tentashipBadgeAwards = pgTable(
  'tentaship_badge_awards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    definitionId: uuid('definition_id').notNull(),
    definitionVersionId: uuid('definition_version_id').notNull(),
    participantType: text('participant_type').$type<BadgeParticipantType>().notNull(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'restrict' }),
    evidenceKind: text('evidence_kind').notNull(),
    /** Deterministic: `<participant id>:<metric>:<threshold>`. Unique per definition (replay protection). */
    evidenceRef: text('evidence_ref').notNull(),
    /** sha256 of the ordered ids of the verified source records that satisfied the rule. */
    evidenceHash: text('evidence_hash').notNull(),
    /** Aggregate facts only (metric, observed count, threshold). No customer or business content. */
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
    awardedAt: timestamp('awarded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The version belongs to the definition, and the participant type is the definition's: both enforced by the database.
    foreignKey({ columns: [t.definitionVersionId, t.definitionId], foreignColumns: [tentashipBadgeDefinitionVersions.id, tentashipBadgeDefinitionVersions.definitionId], name: 'tentaship_badge_awards_version_definition_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.definitionId, t.participantType], foreignColumns: [tentashipBadgeDefinitions.id, tentashipBadgeDefinitions.participantType], name: 'tentaship_badge_awards_definition_participant_fk' }).onDelete('restrict'),
    uniqueIndex('tentaship_badge_awards_one_per_customer_idx').on(t.definitionId, t.customerId).where(sql`${t.customerId} IS NOT NULL`),
    uniqueIndex('tentaship_badge_awards_one_per_business_idx').on(t.definitionId, t.businessId).where(sql`${t.businessId} IS NOT NULL`),
    uniqueIndex('tentaship_badge_awards_evidence_uq').on(t.definitionId, t.evidenceKind, t.evidenceRef),
    index('tentaship_badge_awards_customer_idx').on(t.customerId, t.awardedAt),
    index('tentaship_badge_awards_business_idx').on(t.businessId, t.awardedAt),
    check('tentaship_badge_awards_participant_shape', sql`(${t.participantType} = 'customer' AND ${t.customerId} IS NOT NULL AND ${t.businessId} IS NULL) OR (${t.participantType} = 'business' AND ${t.businessId} IS NOT NULL AND ${t.customerId} IS NULL)`),
    check('tentaship_badge_awards_hash_format', sql`${t.evidenceHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Approved revocation (D-2 / D-5): APPEND-ONLY, at most one per award. A revoked award stays in the ledger; it is never deleted or re-issued. */
export const tentashipBadgeRevocations = pgTable(
  'tentaship_badge_revocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    awardId: uuid('award_id').notNull().references(() => tentashipBadgeAwards.id, { onDelete: 'restrict' }),
    reasonCode: text('reason_code').notNull(),
    /** Operator note: no personal data (enforced by review, not by schema). */
    note: text('note').notNull(),
    authorizedByUserId: uuid('authorized_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tentaship_badge_revocations_award_uq').on(t.awardId),
    check('tentaship_badge_revocations_reason_valid', sql`${t.reasonCode} IN ('evidence_reversed','fraud_confirmed','eligibility_lost','issued_in_error')`),
    check('tentaship_badge_revocations_note_length', sql`char_length(${t.note}) BETWEEN 1 AND 500`),
  ],
);
