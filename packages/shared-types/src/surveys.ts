import { z } from 'zod';

export const surveyOwnerTypeSchema = z.enum(['platform', 'business']);
export type SurveyOwnerType = z.infer<typeof surveyOwnerTypeSchema>;

export const surveyStatusSchema = z.enum(['draft', 'published', 'paused', 'closed', 'archived']);
export type SurveyStatus = z.infer<typeof surveyStatusSchema>;

export const surveyVersionStatusSchema = z.enum(['draft', 'published', 'archived']);
export type SurveyVersionStatus = z.infer<typeof surveyVersionStatusSchema>;

export const surveyQuestionTypeSchema = z.enum([
  'text',
  'textarea',
  'rating',
  'single_choice',
  'multi_choice',
  'boolean',
  'number',
]);
export type SurveyQuestionType = z.infer<typeof surveyQuestionTypeSchema>;

export const surveyCampaignStatusSchema = z.enum(['draft', 'active', 'paused', 'closed']);
export type SurveyCampaignStatus = z.infer<typeof surveyCampaignStatusSchema>;

export const surveyAudienceClassSchema = z.enum([
  'customer',
  'community_candidate',
  'community_member',
  'business_member',
  'general_authenticated_participant',
]);
export type SurveyAudienceClass = z.infer<typeof surveyAudienceClassSchema>;

export const surveyRepeatPolicySchema = z.enum(['once', 'once_per_campaign', 'repeatable']);
export type SurveyRepeatPolicy = z.infer<typeof surveyRepeatPolicySchema>;

export const surveyParticipationStatusSchema = z.enum([
  'started',
  'submitted',
  'completed',
  'invalidated',
]);
export type SurveyParticipationStatus = z.infer<typeof surveyParticipationStatusSchema>;

export const surveyParticipationSourceSchema = z.enum([
  'direct',
  'business_qr',
  'customer_qr',
  'link',
  'staff_assisted',
  'other',
]);
export type SurveyParticipationSource = z.infer<typeof surveyParticipationSourceSchema>;

export const surveyQuestionValidationSchema = z
  .object({
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(1).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .superRefine((validation, ctx) => {
    if (
      validation.minLength !== undefined &&
      validation.maxLength !== undefined &&
      validation.maxLength < validation.minLength
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxLength'],
        message: 'maxLength must be greater than or equal to minLength.',
      });
    }
    if (validation.min !== undefined && validation.max !== undefined && validation.max < validation.min) {
      ctx.addIssue({
        code: 'custom',
        path: ['max'],
        message: 'max must be greater than or equal to min.',
      });
    }
  });

export type SurveyQuestionValidation = z.infer<typeof surveyQuestionValidationSchema>;

export const surveyQuestionInputSchema = z
  .object({
    key: z.string().trim().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().trim().min(1).max(500),
    type: surveyQuestionTypeSchema,
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(200)).min(1).max(50).optional(),
    validation: surveyQuestionValidationSchema.optional(),
  })
  .superRefine((question, ctx) => {
    const isChoice = question.type === 'single_choice' || question.type === 'multi_choice';
    if (isChoice && !question.options?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Choice questions require options.',
      });
    }
    if (!isChoice && question.options !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Options are only valid for choice questions.',
      });
    }
    if (
      question.validation &&
      !['text', 'textarea', 'number', 'rating'].includes(question.type)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['validation'],
        message: 'Validation limits are only valid for text, textarea, number, or rating questions.',
      });
    }
  });

export type SurveyQuestionInput = z.infer<typeof surveyQuestionInputSchema>;

export const createSurveySchema = z.object({
  name: z.string().trim().min(1).max(200),
});
export type CreateSurveyInput = z.infer<typeof createSurveySchema>;

export const createSurveyVersionSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(4000).optional(),
    questions: z.array(surveyQuestionInputSchema).min(1).max(100),
  })
  .superRefine((version, ctx) => {
    const keys = new Set<string>();
    version.questions.forEach((question, index) => {
      if (keys.has(question.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['questions', index, 'key'],
          message: 'Question keys must be unique within a survey version.',
        });
      }
      keys.add(question.key);
    });
  });

export type CreateSurveyVersionInput = z.infer<typeof createSurveyVersionSchema>;

export const createSurveyCampaignSchema = z
  .object({
    surveyVersionId: z.uuid(),
    branchId: z.uuid().optional(),
    name: z.string().trim().min(1).max(200),
    audienceClass: surveyAudienceClassSchema,
    repeatPolicy: surveyRepeatPolicySchema.default('once_per_campaign'),
    startsAt: z.iso.datetime().optional(),
    endsAt: z.iso.datetime().optional(),
    maxResponses: z.number().int().positive().max(1_000_000).optional(),
    exposeInQrResolver: z.boolean().default(false),
  })
  .superRefine((campaign, ctx) => {
    if (campaign.startsAt && campaign.endsAt && new Date(campaign.endsAt) <= new Date(campaign.startsAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'endsAt must be later than startsAt.',
      });
    }
  });

export type CreateSurveyCampaignInput = z.infer<typeof createSurveyCampaignSchema>;

export const surveyAnswerValueSchema = z.union([
  z.string().max(10_000),
  z.number(),
  z.boolean(),
  z.array(z.string().max(500)).max(50),
]);

export const surveyAnswerInputSchema = z.object({
  questionId: z.uuid(),
  value: surveyAnswerValueSchema,
});
export type SurveyAnswerInput = z.infer<typeof surveyAnswerInputSchema>;

export const startSurveyParticipationSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
});
export type StartSurveyParticipationInput = z.infer<typeof startSurveyParticipationSchema>;

export const submitSurveyParticipationSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  answers: z.array(surveyAnswerInputSchema).max(100),
});
export type SubmitSurveyParticipationInput = z.infer<typeof submitSurveyParticipationSchema>;

export const surveyQuestionSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  label: z.string(),
  type: surveyQuestionTypeSchema,
  required: z.boolean(),
  position: z.number().int().min(0),
  options: z.array(z.string()).nullable(),
  validation: surveyQuestionValidationSchema.nullable(),
});
export type SurveyQuestionDto = z.infer<typeof surveyQuestionSchema>;

export const surveyVersionSchema = z.object({
  id: z.uuid(),
  surveyId: z.uuid(),
  version: z.number().int().positive(),
  status: surveyVersionStatusSchema,
  title: z.string(),
  description: z.string().nullable(),
  publishedAt: z.string().nullable(),
  questions: z.array(surveyQuestionSchema),
});
export type SurveyVersionDto = z.infer<typeof surveyVersionSchema>;

export const surveyCampaignSchema = z.object({
  id: z.uuid(),
  surveyId: z.uuid(),
  surveyVersionId: z.uuid(),
  businessId: z.uuid().nullable(),
  branchId: z.uuid().nullable(),
  name: z.string(),
  status: surveyCampaignStatusSchema,
  audienceClass: surveyAudienceClassSchema,
  repeatPolicy: surveyRepeatPolicySchema,
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  maxResponses: z.number().int().positive().nullable(),
  exposeInQrResolver: z.boolean(),
});
export type SurveyCampaignDto = z.infer<typeof surveyCampaignSchema>;

export const surveyParticipationSchema = z.object({
  id: z.uuid(),
  surveyId: z.uuid(),
  surveyVersionId: z.uuid(),
  campaignId: z.uuid(),
  participantCustomerId: z.uuid(),
  businessId: z.uuid().nullable(),
  branchId: z.uuid().nullable(),
  status: surveyParticipationStatusSchema,
  source: surveyParticipationSourceSchema,
  startedAt: z.string(),
  submittedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  invalidatedAt: z.string().nullable(),
});
export type SurveyParticipationDto = z.infer<typeof surveyParticipationSchema>;
