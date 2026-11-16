import {
  pgTable, uuid, text, timestamp, integer, boolean, index, uniqueIndex, check, primaryKey, type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

/**
 * NETWORK-01 (development, additive). Platform-OFFICIAL posts only: business posts need a live published BDPN
 * profile, which does not exist yet (NETWORK-00 N-06), so `content_class` is constrained to 'official' and a later,
 * separately authorized block widens it together with its composite tenant foreign key.
 *
 * Disciplines taken from NETWORK-00 / BDPN-01: immutable revisions with a content digest, a live-revision pointer,
 * pre-moderation (nothing is visible until approved), reviewer != author, and TWO distinct approvers for an official
 * post. The rules are enforced in the DATABASE as well as in the service (triggers in migration 0077), so a direct
 * SQL session cannot publish an unapproved or self-approved revision.
 */
export const NETWORK_CONTENT_CLASSES = ['official'] as const;
export type NetworkContentClass = (typeof NETWORK_CONTENT_CLASSES)[number];
export const NETWORK_POST_STATES = ['unpublished', 'published', 'suspended', 'withdrawn'] as const;
export type NetworkPostState = (typeof NETWORK_POST_STATES)[number];
export const NETWORK_REVISION_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'superseded'] as const;
export type NetworkRevisionStatus = (typeof NETWORK_REVISION_STATUSES)[number];
export const NETWORK_LOCALES = ['en', 'fr', 'es', 'ar'] as const;
/** Code-owned reason list (NETWORK-00 moderation section 3); also a CHECK in the database. */
export const NETWORK_REASON_CODES = [
  'hate_or_harassment', 'threats', 'sexual_content', 'illegal_goods_services', 'fraud_or_scam', 'impersonation',
  'personal_data', 'misleading_claim', 'competitor_disparagement', 'unsafe_link', 'spam_or_duplicate',
] as const;
export type NetworkReasonCode = (typeof NETWORK_REASON_CODES)[number];
export const NETWORK_MAX_BODY_CHARS = 2000;
export const NETWORK_REQUIRED_APPROVALS = 2;
export const NETWORK_DEFAULT_EXPIRY_DAYS = 30;

const reasonList = sql.raw(NETWORK_REASON_CODES.map((c) => `'${c}'`).join(','));
const localeList = sql.raw(NETWORK_LOCALES.map((c) => `'${c}'`).join(','));

export const networkPosts = pgTable('network_posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Opaque public identifier (22 base64url characters); the internal id is never exposed. */
  handle: text('handle').notNull(),
  contentClass: text('content_class').$type<NetworkContentClass>().notNull().default('official'),
  authorUserId: uuid('author_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  state: text('state').$type<NetworkPostState>().notNull().default('unpublished'),
  liveRevisionId: uuid('live_revision_id').references((): AnyPgColumn => networkPostRevisions.id, { onDelete: 'restrict' }),
  pinned: boolean('pinned').notNull().default(false),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  stateChangedAt: timestamp('state_changed_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('network_posts_handle_uq').on(t.handle),
  // At most ONE pinned post (platform-wide for official content).
  uniqueIndex('network_posts_one_pinned_uq').on(t.contentClass).where(sql`${t.pinned} AND ${t.state} = 'published'`),
  index('network_posts_feed_idx').on(t.state, t.pinned, t.publishedAt, t.id),
  check('network_posts_handle_format', sql`${t.handle} ~ '^[A-Za-z0-9_-]{22}$'`),
  check('network_posts_class_official_only', sql`${t.contentClass} = 'official'`),
  check('network_posts_state_valid', sql`${t.state} IN ('unpublished','published','suspended','withdrawn')`),
  check('network_posts_pin_requires_published', sql`NOT ${t.pinned} OR ${t.state} = 'published'`),
  check('network_posts_published_has_evidence', sql`${t.state} NOT IN ('published','suspended') OR (${t.liveRevisionId} IS NOT NULL AND ${t.publishedAt} IS NOT NULL AND ${t.expiresAt} IS NOT NULL)`),
  check('network_posts_expiry_after_publish', sql`${t.expiresAt} IS NULL OR ${t.publishedAt} IS NULL OR ${t.expiresAt} > ${t.publishedAt}`),
]);

export const networkPostRevisions = pgTable('network_post_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id').notNull().references(() => networkPosts.id, { onDelete: 'restrict' }),
  revisionNo: integer('revision_no').notNull(),
  body: text('body').notNull(),
  linkUrl: text('link_url'),
  contentLocale: text('content_locale').notNull(),
  /** SHA-256 of the canonical NFC text (body, link, locale); recomputed at submission and approval. */
  contentDigest: text('content_digest').notNull(),
  status: text('status').$type<NetworkRevisionStatus>().notNull().default('draft'),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'restrict' }),
  reasonCode: text('reason_code').$type<NetworkReasonCode>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('network_post_revisions_no_uq').on(t.postId, t.revisionNo),
  uniqueIndex('network_post_revisions_one_draft_uq').on(t.postId).where(sql`${t.status} = 'draft'`),
  uniqueIndex('network_post_revisions_one_submitted_uq').on(t.postId).where(sql`${t.status} = 'submitted'`),
  index('network_post_revisions_queue_idx').on(t.status, t.submittedAt),
  check('network_rev_no_positive', sql`${t.revisionNo} >= 1`),
  check('network_rev_body_length', sql`char_length(${t.body}) BETWEEN 1 AND ${sql.raw(String(NETWORK_MAX_BODY_CHARS))}`),
  check('network_rev_body_plain_text', sql`${t.body} !~ '[<>]' AND ${t.body} !~ '[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]'`),
  check('network_rev_link_https', sql`${t.linkUrl} IS NULL OR (${t.linkUrl} ~ '^https://[^[:space:]<>"]+$' AND char_length(${t.linkUrl}) <= 2048)`),
  check('network_rev_locale', sql`${t.contentLocale} IN (${localeList})`),
  check('network_rev_digest_format', sql`${t.contentDigest} ~ '^[0-9a-f]{64}$'`),
  check('network_rev_status_valid', sql`${t.status} IN ('draft','submitted','approved','rejected','superseded')`),
  check('network_rev_submitted_evidence', sql`(${t.status} = 'draft') = (${t.submittedAt} IS NULL)`),
  check('network_rev_decision_evidence', sql`${t.status} NOT IN ('approved','rejected') OR (${t.decidedAt} IS NOT NULL AND ${t.decidedBy} IS NOT NULL)`),
  check('network_rev_rejection_reason', sql`(${t.status} = 'rejected') = (${t.reasonCode} IS NOT NULL)`),
  check('network_rev_reason_valid', sql`${t.reasonCode} IS NULL OR ${t.reasonCode} IN (${reasonList})`),
  check('network_rev_decider_not_author', sql`${t.decidedBy} IS NULL OR ${t.decidedBy} <> ${t.createdBy}`),
]);

/** One row per distinct approver of a submitted revision. Two are required before a post can be published. */
export const networkRevisionApprovals = pgTable('network_revision_approvals', {
  revisionId: uuid('revision_id').notNull().references(() => networkPostRevisions.id, { onDelete: 'restrict' }),
  approverUserId: uuid('approver_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.revisionId, t.approverUserId] })]);
