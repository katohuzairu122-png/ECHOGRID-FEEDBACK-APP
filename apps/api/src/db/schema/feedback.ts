import { pgTable, uuid, text, integer, real, boolean, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns, softDeleteColumns } from './_shared';
import { businesses } from './businesses';
import { branches } from './branches';
import { qrCodes } from './qr-codes';

/**
 * A single customer-submitted rating/comment, captured anonymously through
 * the public `POST /qr/:token/feedback` endpoint -- no `users` row exists
 * for the customer, so `createdBy` stays NULL for every row here, the same
 * way `audit_log` already handles "no authenticated actor" for signup/login.
 *
 * All three FKs cascade on delete, deliberately NOT the `audit_log` pattern
 * (`ON DELETE SET NULL`): feedback is normal tenant-owned business data, not
 * an immutable compliance trail, and every repository method in this schema
 * requires a real `businessId` to enforce tenant isolation -- a feedback row
 * with a NULLed-out businessId would become unreachable through that
 * convention rather than usefully preserved. If a business or branch is
 * deleted, its customers' submitted data (including any optional PII --
 * customerEmail/customerPhone below) going with it is the correct default,
 * not an oversight.
 */
export const feedback = pgTable(
  'feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    // NOT NULL: every submission today arrives via a QR scan -- that is the
    // entire premise of this module, and no other intake channel exists.
    // Loosening this to nullable later (if a direct-link or email-survey
    // channel is ever built) is a simple migration; starting nullable "just
    // in case" now would be guessing at a feature that isn't designed.
    qrCodeId: uuid('qr_code_id')
      .notNull()
      .references(() => qrCodes.id, { onDelete: 'cascade' }),
    rating: integer('rating').notNull(),
    comment: text('comment'),
    // All three optional -- a contact-info wall in front of a 1-5 star tap
    // would defeat the entire point of a frictionless QR flow. Format
    // validation (email shape, etc.) happens at the Zod layer (Block 2),
    // matching how `users.email` also carries no DB-level format check.
    customerName: text('customer_name'),
    customerEmail: text('customer_email'),
    customerPhone: text('customer_phone'),
    // ONE optional AI-generated follow-up question + the customer's optional
    // answer -- not a transcript/thread, only one Q&A pair is ever supported
    // (see submitFeedbackSchema). followUpAnswer is meaningless without
    // followUpQuestion; that pairing is enforced in FeedbackService.submit,
    // not a CHECK constraint, matching how sentiment/sentimentScore's
    // cross-validation above also lives in code, not SQL.
    followUpQuestion: text('follow_up_question'),
    followUpAnswer: text('follow_up_answer'),
    // Level 1 deterministic processing (Continuing Development spec S3.1/
    // S9.1) -- see feedback/text-normalizer.ts for the exact algorithm.
    // Nullable: a comment-less submission has no text to hash. Not used for
    // display; it exists purely so the partial index below can answer
    // "has this exact text been submitted at this branch before" with a
    // plain indexed lookup instead of scanning `comment` row by row.
    normalizedTextHash: text('normalized_text_hash'),
    // The recorded FACT that normalizedTextHash matched an earlier row at
    // the same business+branch, computed once at submit time. Deliberately
    // just a boolean, not a fraud-reason-code or review-case reference --
    // those need the fraud-signal schema (S9.1, Continuing Development
    // Block 3) and manual-review model (Continuing Development Block 5)
    // that don't exist yet -- named in full here since this file already
    // uses bare "Block N" elsewhere for the original build's own numbering,
    // a different sequence. This column is the foundation
    // that later work reads, not the fraud decision itself; Level 1 only
    // detects and records, it never rejects a submission (S2.9/S2.15).
    isDuplicateText: boolean('is_duplicate_text').notNull().default(false),
    // Continuing Development S5-A (spec S5.6 "frequency checks"). How many
    // EARLIER non-deleted submissions at this same business+branch carried
    // this exact normalized text, counted once at submit time over a bounded
    // lookback window (feedback.service.ts's DUPLICATE_LOOKBACK_DAYS).
    //
    // Stored rather than derived on read because it is a point-in-time fact:
    // recounting next week answers a different question, since more matches
    // may have arrived since. `isDuplicateText` above is exactly
    // `duplicateTextCount > 0` -- kept as its own column rather than dropped
    // because it is what the existing partial index and inbox filtering are
    // shaped around, and a boolean and a rate are different questions: one
    // repeat is unremarkable, thirty in a day is a template.
    //
    // 0 for a comment-less submission and for any comment below
    // text-normalizer.ts's MIN_DISTINCTIVE_LENGTH -- those are never hashed,
    // so they are never compared, so the honest count is zero rather than
    // unknown.
    duplicateTextCount: integer('duplicate_text_count').notNull().default(0),
    // Business-meaningful triage state, distinct from isDeleted below (which
    // is for actually removing a spam/abusive submission). Lets an owner
    // mark something seen without a full ticketing workflow. The UI for
    // changing this ships later (Block 5) -- the column exists from the
    // start since adding it after real rows exist would need a backfill.
    status: text('status').notNull().default('new'),
    // Automated Feedback Sorting -- category is deliberately uncons­trained at
    // the DB level, same reasoning as qr_codes.type: the full taxonomy isn't
    // fixed forever (spec explicitly requires "extensible without destructive
    // migrations"), so the known-value list lives in shared-types/code
    // (feedback-classification.ts) instead of a CHECK constraint that a new
    // category would otherwise force a migration to widen.
    category: text('category'),
    // Closed set, unlike category -- P0-P3 is a stable, fully-designed scale
    // (see feedback-classification.ts), so a CHECK constraint is the right
    // guard here, same reasoning as qr_codes.status.
    urgency: text('urgency'),
    // Plain nullable UUID with no FK to `users`, matching auditColumns'
    // createdBy/updatedBy convention exactly (metadata, not relational
    // integrity -- enforced at the application layer instead).
    assignedTo: uuid('assigned_to'),
    // AI Sentiment Analytics module (added Block 1, not part of the original
    // QR Engagement schema). `sentiment` is nullable/pending until the
    // classification pipeline (Block 2) runs -- every existing row at
    // migration time starts NULL/'pending' rather than backfilled, since
    // there is no reliable retroactive way to know if a backfill run
    // actually happened for a given row without this exact state machine.
    // `sentimentScore` is a raw -1..1 confidence signal for trend charts;
    // `sentiment` is the bucketed label actually shown in the UI, so the two
    // are never allowed to disagree at the CHECK-constraint level (score
    // range is enforced but not cross-validated against the label -- that
    // mapping lives in code, in sentiment/sentiment-classifier.ts, so it can
    // evolve without a migration).
    sentiment: text('sentiment'),
    sentimentScore: real('sentiment_score'),
    // 'manual' (Continuing Development S4 Block 10, S4.3 "allow authorized
    // manual classification") is a fifth terminal state alongside
    // completed/failed/skipped: an authorized human set category/urgency/
    // sentiment by hand, either to correct a wrong AI call or to rescue a
    // row the pipeline repeatedly failed on.
    //
    // Deliberately its own value rather than reusing 'completed', for the
    // same reason ai_usage_log distinguishes 'abandoned' from 'failed':
    // 'completed' asserts that automated analysis ran and succeeded, which
    // for a manually-classified row is false -- often the automation failed
    // outright, which is why a human intervened. Collapsing them would make
    // "how often does the classifier actually work" unanswerable, and that
    // number is the one worth watching.
    //
    // It also has to be distinct from 'failed' for a product reason: the
    // "Unclassified" saved view is defined as analysis_status IN
    // ('pending','failed') (feedback-saved-views.ts), so leaving a
    // hand-classified row at 'failed' would strand it in that view forever
    // -- resolving exactly the queue the human just worked through.
    analysisStatus: text('analysis_status').notNull().default('pending'),
    // Set by both paths: the queue consumer on completion/failure, and the
    // manual override on classification. "When analysis reached a terminal
    // state" is true of both, so this needs no manual-specific twin --
    // `analysisStatus = 'manual'` already records which path got there, and
    // `updatedBy` plus audit_log record who.
    analyzedAt: timestamp('analyzed_at', { withTimezone: true }),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (table) => [
    index('feedback_branch_created_idx').on(table.branchId, table.createdAt),
    index('feedback_business_created_idx').on(table.businessId, table.createdAt),
    // Powers both the analytics dashboard's sentiment filter and the queue
    // consumer's backfill/retry sweep (WHERE analysis_status = 'pending').
    index('feedback_business_sentiment_idx').on(table.businessId, table.sentiment),
    index('feedback_analysis_status_idx').on(table.analysisStatus),
    // Inbox filtering (Automated Feedback Sorting) -- each is tenant-scoped
    // (leads with businessId) since every inbox query is already scoped to
    // one business first, same shape as feedback_business_sentiment_idx.
    index('feedback_business_category_idx').on(table.businessId, table.category),
    index('feedback_business_urgency_idx').on(table.businessId, table.urgency),
    index('feedback_business_assigned_idx').on(table.businessId, table.assignedTo),
    // Backs the "Critical now" saved view and the escalation sweep's own
    // WHERE urgency = 'P0_CRITICAL' scan -- partial, since P0 rows are a
    // small fraction of the table and a full-width index would waste space
    // indexing the overwhelmingly common P1-P3/NULL rows for a query that
    // never asks about them.
    index('feedback_critical_idx')
      .on(table.businessId, table.createdAt)
      .where(sql`${table.urgency} = 'P0_CRITICAL'`),
    // Backs findMostRecentByNormalizedHash's exact-duplicate lookup
    // (FeedbackRepository) -- partial for the same reason as
    // feedback_critical_idx above: most rows have no comment at all, or a
    // comment whose hash is never looked up again, so indexing every NULL
    // would waste space for zero query benefit.
    index('feedback_duplicate_hash_idx')
      .on(table.businessId, table.branchId, table.normalizedTextHash)
      .where(sql`${table.normalizedTextHash} IS NOT NULL`),
    check('feedback_rating_check', sql`${table.rating} BETWEEN 1 AND 5`),
    check('feedback_status_check', sql`${table.status} IN ('new', 'reviewed')`),
    check(
      'feedback_sentiment_check',
      sql`${table.sentiment} IS NULL OR ${table.sentiment} IN ('very_negative', 'negative', 'neutral', 'positive', 'very_positive', 'unknown')`,
    ),
    check(
      'feedback_sentiment_score_check',
      sql`${table.sentimentScore} IS NULL OR ${table.sentimentScore} BETWEEN -1 AND 1`,
    ),
    check(
      'feedback_analysis_status_check',
      sql`${table.analysisStatus} IN ('pending', 'completed', 'failed', 'skipped', 'manual')`,
    ),
    check(
      'feedback_urgency_check',
      sql`${table.urgency} IS NULL OR ${table.urgency} IN ('P0_CRITICAL', 'P1_HIGH', 'P2_NORMAL', 'P3_LOW')`,
    ),
  ],
);
