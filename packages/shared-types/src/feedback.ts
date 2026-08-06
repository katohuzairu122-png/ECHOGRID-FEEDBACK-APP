import { z } from 'zod';

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
  sentiment: z.enum(['positive', 'neutral', 'negative']).nullable(),
  sentimentScore: z.number().nullable(),
  analysisStatus: z.enum(['pending', 'completed', 'failed', 'skipped']),
  analyzedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type FeedbackDto = z.infer<typeof feedbackSchema>;
