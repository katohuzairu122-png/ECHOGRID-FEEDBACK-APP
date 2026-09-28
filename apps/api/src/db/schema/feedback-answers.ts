import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { feedback } from './feedback';
import { feedbackQuestions } from './feedback-forms';

export const feedbackAnswers = pgTable('feedback_answers', {
  id: uuid('id').primaryKey().defaultRandom(),
  feedbackId: uuid('feedback_id').notNull().references(() => feedback.id, { onDelete: 'cascade' }),
  questionId: uuid('question_id').notNull().references(() => feedbackQuestions.id, { onDelete: 'restrict' }),
  questionKey: text('question_key').notNull(),
  questionLabel: text('question_label').notNull(),
  questionType: text('question_type').notNull(),
  value: jsonb('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('feedback_answers_feedback_question_key').on(t.feedbackId, t.questionId),
  index('feedback_answers_feedback_idx').on(t.feedbackId),
]);

