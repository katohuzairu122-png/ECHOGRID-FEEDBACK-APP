import {
  pgTable, uuid, text, timestamp, integer, index, uniqueIndex, unique, check, primaryKey, foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { businessCategories } from './business-categories';

/**
 * BDPN profile storage foundation (BDPN-F1, development only, additive, nothing reads or writes it yet).
 * Implements `BDPN_01A_DATA_CONTRACTS_AND_SCHEMA_PROPOSAL.md` sections 2 to 5 with owner ruling OD-24 (per-block
 * migrations, 2026-11-18). Storage and database guards only: no routes, no services, no permissions, no discovery
 * read model, no seed data and no UI. `business_public_profiles` is lazy (no row exists until a business first saves a
 * draft) and nothing is backfilled for existing businesses.
 *
 * Disciplines (BDPN-01A 4.x): immutable revisions with a content digest, a live-revision pointer that can only
 * reference an APPROVED revision of the SAME business, pre-moderation (nothing is visible until approved),
 * submitter != reviewer enforced by the database, an opaque random handle, no media, no coordinates, no public phone
 * or email, plan entitlement NOT stored (D-24 is reserved as a read-only term of the eligibility predicate).
 * The legal state transitions are enforced by triggers in migration 0080 so a direct SQL session cannot bypass them.
 */
export const PROFILE_LOCALES = ['en', 'es', 'fr', 'ar'] as const;
export type ProfileLocale = (typeof PROFILE_LOCALES)[number];
export const PUBLICATION_STATES = ['unpublished', 'published', 'suspended', 'withdrawn'] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];
export const PROFILE_REVISION_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'superseded'] as const;
export type ProfileRevisionStatus = (typeof PROFILE_REVISION_STATUSES)[number];
export const PROFILE_LOCATION_KINDS = ['place', 'service_area'] as const;
export type ProfileLocationKind = (typeof PROFILE_LOCATION_KINDS)[number];

const localeList = sql.raw(PROFILE_LOCALES.map((c) => `'${c}'`).join(','));

/** D-11: localized platform category names. The existing English `business_categories.name` stays the fallback. */
export const businessCategoryTranslations = pgTable('business_category_translations', {
  categoryId: uuid('category_id').notNull().references(() => businessCategories.id, { onDelete: 'restrict' }),
  locale: text('locale').notNull(),
  name: text('name').notNull(),
}, (t) => [
  primaryKey({ columns: [t.categoryId, t.locale] }),
  check('business_category_translations_locale', sql`${t.locale} IN (${localeList})`),
  check('business_category_translations_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 80`),
]);

/** Immutable content versions (D-01, D-14). Content is frozen once submitted. */
export const businessProfileRevisions = pgTable('business_profile_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
  revisionNo: integer('revision_no').notNull(),
  status: text('status').$type<ProfileRevisionStatus>().notNull().default('draft'),
  /** https only (D-07); no public phone or email columns exist. */
  websiteUrl: text('website_url'),
  /** SHA-256 of the canonical content (BDPN-01A 4.3), set at submission, recomputed at approval. */
  contentDigest: text('content_digest'),
  submittedBy: uuid('submitted_by'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewReasonCode: text('review_reason_code'),
  /** Never exposed to customers. */
  reviewNoteInternal: text('review_note_internal'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
}, (t) => [
  uniqueIndex('business_profile_revisions_no_uq').on(t.businessId, t.revisionNo),
  // Target of the composite tenant foreign keys (a constraint, created with the table, so the keys can reference it).
  unique('business_profile_revisions_id_business_key').on(t.id, t.businessId),
  // At most one open draft and at most one revision awaiting review per business.
  uniqueIndex('business_profile_revisions_one_draft_uq').on(t.businessId).where(sql`${t.status} = 'draft'`),
  uniqueIndex('business_profile_revisions_one_submitted_uq').on(t.businessId).where(sql`${t.status} = 'submitted'`),
  index('business_profile_revisions_business_status_idx').on(t.businessId, t.status),
  index('business_profile_revisions_queue_idx').on(t.status, t.submittedAt).where(sql`${t.status} = 'submitted'`),
  check('business_profile_revisions_no_positive', sql`${t.revisionNo} >= 1`),
  check('business_profile_revisions_status_valid', sql`${t.status} IN ('draft','submitted','approved','rejected','superseded')`),
  check('business_profile_revisions_website_https', sql`${t.websiteUrl} IS NULL OR (${t.websiteUrl} ~ '^https://[^[:space:]<>"]+$' AND char_length(${t.websiteUrl}) <= 2048)`),
  check('business_profile_revisions_digest_format', sql`${t.contentDigest} IS NULL OR ${t.contentDigest} ~ '^[0-9a-f]{64}$'`),
  check('business_profile_revisions_digest_required', sql`${t.status} = 'draft' OR ${t.contentDigest} IS NOT NULL`),
  check('business_profile_revisions_submission_evidence', sql`(${t.status} = 'draft') = (${t.submittedAt} IS NULL) AND (${t.status} = 'draft') = (${t.submittedBy} IS NULL)`),
  check('business_profile_revisions_review_fields', sql`(${t.status} IN ('approved','rejected','superseded')) = (${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL)`),
  check('business_profile_revisions_reason_scope', sql`(${t.status} = 'rejected') = (${t.reviewReasonCode} IS NOT NULL)`),
  check('business_profile_revisions_reason_format', sql`${t.reviewReasonCode} IS NULL OR ${t.reviewReasonCode} ~ '^[A-Z_]{3,40}$'`),
  check('business_profile_revisions_note_length', sql`${t.reviewNoteInternal} IS NULL OR char_length(${t.reviewNoteInternal}) <= 500`),
  // Self-approval is refused by the DATABASE, not only by application code.
  check('business_profile_revisions_separation_of_duties', sql`${t.reviewedBy} IS NULL OR ${t.submittedBy} IS NULL OR ${t.reviewedBy} <> ${t.submittedBy}`),
]);

/** One publication record per business that has ever started a profile (D-01, D-10, D-13). */
export const businessPublicProfiles = pgTable('business_public_profiles', {
  businessId: uuid('business_id').primaryKey().references(() => businesses.id, { onDelete: 'restrict' }),
  /** 128-bit CSPRNG value, base64url, generated by the application, never derived from other data (D-10). */
  profileHandle: text('profile_handle').notNull(),
  publicationState: text('publication_state').$type<PublicationState>().notNull().default('unpublished'),
  /** The live revision. Kept while `withdrawn` or `suspended` so a re-publish is possible (D-13). */
  publishedRevisionId: uuid('published_revision_id'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  suspendedBy: uuid('suspended_by'),
  suspensionReasonCode: text('suspension_reason_code'),
  /** Optimistic-lock counter, incremented on every transition. */
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
}, (t) => [
  uniqueIndex('business_public_profiles_handle_uq').on(t.profileHandle),
  index('business_public_profiles_published_idx').on(t.businessId).where(sql`${t.publicationState} = 'published'`),
  // The pointer can only reference a revision of the SAME business (composite tenant foreign key).
  foreignKey({
    name: 'business_public_profiles_pointer_business_fk',
    columns: [t.businessId, t.publishedRevisionId],
    foreignColumns: [businessProfileRevisions.businessId, businessProfileRevisions.id],
  }).onDelete('restrict'),
  check('business_public_profiles_handle_format', sql`${t.profileHandle} ~ '^[A-Za-z0-9_-]{22}$'`),
  check('business_public_profiles_state_valid', sql`${t.publicationState} IN ('unpublished','published','suspended','withdrawn')`),
  check('business_public_profiles_version_positive', sql`${t.version} >= 1`),
  check('business_public_profiles_published_needs_pointer', sql`${t.publicationState} <> 'published' OR ${t.publishedRevisionId} IS NOT NULL`),
  check('business_public_profiles_published_needs_evidence', sql`${t.publicationState} <> 'published' OR ${t.publishedAt} IS NOT NULL`),
  check('business_public_profiles_suspended_fields', sql`(${t.publicationState} = 'suspended') = (${t.suspendedAt} IS NOT NULL AND ${t.suspensionReasonCode} IS NOT NULL)`),
  check('business_public_profiles_suspension_cleared', sql`${t.publicationState} = 'suspended' OR (${t.suspendedAt} IS NULL AND ${t.suspendedBy} IS NULL AND ${t.suspensionReasonCode} IS NULL)`),
  check('business_public_profiles_suspension_reason_format', sql`${t.suspensionReasonCode} IS NULL OR ${t.suspensionReasonCode} ~ '^[A-Z_]{3,40}$'`),
]);

/** Per-locale text of a revision. Only the display name is mandatory for a non-default locale. */
export const businessProfileRevisionTranslations = pgTable('business_profile_revision_translations', {
  revisionId: uuid('revision_id').notNull(),
  /** Carried for the composite tenant foreign key. */
  businessId: uuid('business_id').notNull(),
  locale: text('locale').notNull(),
  displayName: text('display_name').notNull(),
  summary: text('summary'),
  description: text('description'),
}, (t) => [
  primaryKey({ columns: [t.revisionId, t.locale] }),
  foreignKey({
    name: 'business_profile_revision_translations_revision_business_fk',
    columns: [t.revisionId, t.businessId],
    foreignColumns: [businessProfileRevisions.id, businessProfileRevisions.businessId],
  }).onDelete('restrict'),
  index('business_profile_revision_translations_name_idx').on(t.locale, sql`lower(${t.displayName})`),
  check('business_profile_revision_translations_locale', sql`${t.locale} IN (${localeList})`),
  check('business_profile_revision_translations_name_length', sql`char_length(btrim(${t.displayName})) BETWEEN 2 AND 80`),
  check('business_profile_revision_translations_summary_length', sql`${t.summary} IS NULL OR char_length(${t.summary}) BETWEEN 1 AND 160`),
  check('business_profile_revision_translations_description_length', sql`${t.description} IS NULL OR char_length(${t.description}) BETWEEN 1 AND 1000`),
]);

/** Opt-in public places and service areas of a revision (D-06). No coordinates, no branch reference, no geometry. */
export const businessProfileRevisionLocations = pgTable('business_profile_revision_locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  revisionId: uuid('revision_id').notNull(),
  businessId: uuid('business_id').notNull(),
  position: integer('position').notNull(),
  kind: text('kind').$type<ProfileLocationKind>().notNull(),
  label: text('label').notNull(),
  countryCode: text('country_code'),
  city: text('city'),
  region: text('region'),
  /** Only when the business opted in, and only for a `place`. */
  streetAddress: text('street_address'),
}, (t) => [
  foreignKey({
    name: 'business_profile_revision_locations_revision_business_fk',
    columns: [t.revisionId, t.businessId],
    foreignColumns: [businessProfileRevisions.id, businessProfileRevisions.businessId],
  }).onDelete('restrict'),
  uniqueIndex('business_profile_revision_locations_position_uq').on(t.revisionId, t.position),
  check('business_profile_revision_locations_position_nonneg', sql`${t.position} >= 0`),
  check('business_profile_revision_locations_kind', sql`${t.kind} IN ('place','service_area')`),
  check('business_profile_revision_locations_label_length', sql`char_length(${t.label}) BETWEEN 1 AND 120`),
  check('business_profile_revision_locations_country_format', sql`${t.countryCode} IS NULL OR ${t.countryCode} ~ '^[A-Z]{2}$'`),
  check('business_profile_revision_locations_city_length', sql`${t.city} IS NULL OR char_length(${t.city}) BETWEEN 1 AND 80`),
  check('business_profile_revision_locations_region_length', sql`${t.region} IS NULL OR char_length(${t.region}) BETWEEN 1 AND 80`),
  check('business_profile_revision_locations_street_length', sql`${t.streetAddress} IS NULL OR char_length(${t.streetAddress}) BETWEEN 1 AND 160`),
  check('business_profile_revision_locations_place_fields', sql`${t.kind} <> 'place' OR (${t.city} IS NOT NULL AND ${t.countryCode} IS NOT NULL)`),
  check('business_profile_revision_locations_area_no_street', sql`${t.kind} <> 'service_area' OR ${t.streetAddress} IS NULL`),
]);
