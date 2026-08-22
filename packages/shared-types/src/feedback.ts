import { z } from 'zod';
import { feedbackCategorySchema, urgencySchema, sentimentSchema } from './feedback-classification';

/**
 * Public submission contract -- shared by apps/api's validation of
 * POST /qr/:token/feedback and the public landing page's client-side form
 * validation (QR Engagement Block 3). Only `rating` is meaningfully
 * required; every contact field is optional on purpose -- a contact-info
 * wall in front of a 1-5 star tap would defeat the point of a frictionless
 * QR flow.
 */
export const submitFeedbackSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
  customerName: z.string().trim().max(200).optional(),
  customerEmail: z.string().trim().toLowerCase().email().max(320).optional(),
  customerPhone: z.string().trim().max(30).optional(),
  // Both optional, both only meaningful together -- followUpQuestion is
  // echoed back from an earlier POST /qr/:token/follow-up-question call
  // rather than regenerated server-side on submit, so the staff inbox shows
  // exactly what the customer was actually asked. See
  // FeedbackService.submit for the "answer implies question" pairing rule.
  followUpQuestion: z.string().trim().max(500).optional(),
  followUpAnswer: z.string().trim().max(2000).optional(),
});

export type SubmitFeedbackInput = z.infer<typeof submitFeedbackSchema>;

/**
 * Contract for POST /qr/:token/follow-up-question -- a stateless,
 * no-DB-write endpoint that generates ONE optional AI follow-up question
 * from the rating+comment the customer already entered, before they submit.
 */
export const generateFollowUpQuestionSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
});

export type GenerateFollowUpQuestionInput = z.infer<typeof generateFollowUpQuestionSchema>;

export const followUpQuestionSchema = z.object({
  question: z.string(),
});

export type FollowUpQuestionDto = z.infer<typeof followUpQuestionSchema>;

/**
 * Only one transition exists today (new -> reviewed), so this is
 * deliberately a single z.literal rather than a general status-patcher --
 * a business should never be able to edit a customer's rating/comment
 * after the fact, only acknowledge having seen it.
 */
export const updateFeedbackStatusSchema = z.object({
  status: z.literal('reviewed'),
});

export const feedbackSchema = z.object({
  id: z.uuid(),
  businessId: z.uuid(),
  branchId: z.uuid(),
  qrCodeId: z.uuid(),
  rating: z.number(),
  comment: z.string().nullable(),
  customerName: z.string().nullable(),
  customerEmail: z.string().nullable(),
  customerPhone: z.string().nullable(),
  followUpQuestion: z.string().nullable(),
  followUpAnswer: z.string().nullable(),
  status: z.enum(['new', 'reviewed']),
  // AI Sentiment Analytics module (Block 1/2) -- nullable/'pending' until the
  // async classification pipeline runs. Added to the contract alongside the
  // DB schema change even though no UI consumes them until Block 5, so the
  // shared type never drifts from what the API actually returns.
  sentiment: sentimentSchema.nullable(),
  sentimentScore: z.number().nullable(),
  analysisStatus: z.enum(['pending', 'completed', 'failed', 'skipped']),
  analyzedAt: z.string().nullable(),
  // Automated Feedback Sorting -- all three nullable/pending until Level 2
  // classification runs (category/urgency) or a manager assigns it, same
  // "starts empty, filled in async" shape as sentiment above.
  category: feedbackCategorySchema.nullable(),
  urgency: urgencySchema.nullable(),
  assignedTo: z.uuid().nullable(),
  createdAt: z.string(),
});

export type FeedbackDto = z.infer<typeof feedbackSchema>;

/**
 * Inbox filter/sort contract -- every field optional (an empty filter means
 * "show everything for this business"), arrays for the multi-select filters
 * the spec requires (a request can ask for several categories/urgencies at
 * once, not just one). `savedView` is a named preset that expands to a
 * predefined combination of the other fields server-side (see
 * feedback.routes.ts's SAVED_VIEWS) rather than a persisted per-user
 * customization -- see that file's comment for why.
 */
export const feedbackFilterSchema = z.object({
  savedView: z
    .enum([
      'critical_now',
      'high_priority_unresolved',
      'negative_unresolved',
      'follow_up_required',
      'suspected_fraud',
      'unclassified',
      'recently_resolved',
      'positive_feedback',
    ])
    .optional(),
  branchId: z.uuid().optional(),
  category: z.array(feedbackCategorySchema).optional(),
  urgency: z.array(urgencySchema).optional(),
  sentiment: z.array(sentimentSchema).optional(),
  status: z.array(z.enum(['new', 'reviewed'])).optional(),
  analysisStatus: z.array(z.enum(['pending', 'completed', 'failed', 'skipped'])).optional(),
  assignedTo: z.uuid().optional(),
  unassigned: z.boolean().optional(),
  search: z.string().trim().max(500).optional(),
  dateFrom: z.iso.datetime().optional(),
  dateTo: z.iso.datetime().optional(),
  sortBy: z.enum(['createdAt', 'urgency', 'rating']).default('createdAt'),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export type FeedbackFilterInput = z.infer<typeof feedbackFilterSchema>;

/** Manual classification override -- Stage 1's "allow authorized manual
 * classification" requirement, used both for correcting a wrong AI call and
 * for classifying feedback that repeatedly failed automated processing. */
export const classifyFeedbackSchema = z.object({
  category: feedbackCategorySchema.optional(),
  urgency: urgencySchema.optional(),
  sentiment: sentimentSchema.optional(),
});
export type ClassifyFeedbackInput = z.infer<typeof classifyFeedbackSchema>;

export const assignFeedbackSchema = z.object({
  assignedTo: z.uuid().nullable(),
});
export type AssignFeedbackInput = z.infer<typeof assignFeedbackSchema>;

/** Bulk variants of the two mutations above -- same "one call, many ids"
 * shape the spec's "bulk assignment"/"bulk status updates" ask for. Capped
 * at 100 to match feedbackFilterSchema's own page-size ceiling, so a bulk
 * action never exceeds what a single inbox page could have selected. */
export const bulkAssignFeedbackSchema = z.object({
  feedbackIds: z.array(z.uuid()).min(1).max(100),
  assignedTo: z.uuid().nullable(),
});
export type BulkAssignFeedbackInput = z.infer<typeof bulkAssignFeedbackSchema>;

export const bulkUpdateFeedbackStatusSchema = z.object({
  feedbackIds: z.array(z.uuid()).min(1).max(100),
  status: z.literal('reviewed'),
});
export type BulkUpdateFeedbackStatusInput = z.infer<typeof bulkUpdateFeedbackStatusSchema>;
