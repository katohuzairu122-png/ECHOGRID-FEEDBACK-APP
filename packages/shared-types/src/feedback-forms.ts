import { z } from 'zod';

export const feedbackQuestionTypeSchema = z.enum([
  'text', 'textarea', 'rating', 'single_choice', 'multi_choice', 'boolean',
]);
export const feedbackQuestionDefinitionSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  label: z.string(),
  type: feedbackQuestionTypeSchema,
  required: z.boolean(),
  position: z.number().int().min(0),
  options: z.array(z.string()).nullable(),
});
export const publicFeedbackFormSchema = z.object({
  formId: z.uuid(),
  versionId: z.uuid(),
  version: z.number().int().positive(),
  name: z.string(),
  questions: z.array(feedbackQuestionDefinitionSchema),
});
export type PublicFeedbackForm = z.infer<typeof publicFeedbackFormSchema>;

export const feedbackAnswerInputSchema = z.object({
  questionId: z.uuid(),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
});
export type FeedbackAnswerInput = z.infer<typeof feedbackAnswerInputSchema>;

export const createFeedbackFormSchema = z.object({
  name: z.string().trim().min(1).max(200),
  questions: z.array(z.object({
    key: z.string().trim().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().trim().min(1).max(500),
    type: feedbackQuestionTypeSchema,
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  })).min(1).max(50),
}).superRefine((form, ctx) => {
  const keys = new Set<string>();
  form.questions.forEach((question, index) => {
    if (keys.has(question.key)) ctx.addIssue({ code: 'custom', path: ['questions', index, 'key'], message: 'Question keys must be unique.' });
    keys.add(question.key);
    if ((question.type === 'single_choice' || question.type === 'multi_choice') && !question.options?.length) {
      ctx.addIssue({ code: 'custom', path: ['questions', index, 'options'], message: 'Choice questions require options.' });
    }
  });
});
export type CreateFeedbackFormInput = z.infer<typeof createFeedbackFormSchema>;

export const assignFeedbackFormSchema = z.object({
  qrCodeId: z.uuid(),
  versionId: z.uuid(),
});

