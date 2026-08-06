import { pgTable, uuid, text, integer, real, timestamp, index, check } from 'drizzle-orm/pg-core';
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
    // Business-meaningful triage state, distinct from isDeleted below (which
    // is for actually removing a spam/abusive submission). Lets an owner
    // mark something seen without a full ticketing workflow. The UI for
    // changing this ships later (Block 5) -- the column exists from the
    // start since adding it after real rows exist would need a backfill.
    status: text('status').notNull().default('new'),
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
    analysisStatus: text('analysis_status').notNull().default('pending'),
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
    check('feedback_rating_check', sql`${table.rating} BETWEEN 1 AND 5`),
    check('feedback_status_check', sql`${table.status} IN ('new', 'reviewed')`),
    check(
      'feedback_sentiment_check',
      sql`${table.sentiment} IS NULL OR ${table.sentiment} IN ('positive', 'neutral', 'negative')`,
    ),
    check(
      'feedback_sentiment_score_check',
      sql`${table.sentimentScore} IS NULL OR ${table.sentimentScore} BETWEEN -1 AND 1`,
    ),
    check(
      'feedback_analysis_status_check',
      sql`${table.analysisStatus} IN ('pending', 'completed', 'failed', 'skipped')`,
    ),
  ],
);
