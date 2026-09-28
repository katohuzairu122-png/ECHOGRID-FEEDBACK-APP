import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';

export const feedbackForms = pgTable('feedback_forms', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
}, (t) => [index('feedback_forms_business_idx').on(t.businessId)]);

export const feedbackFormVersions = pgTable('feedback_form_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  formId: uuid('form_id').notNull().references(() => feedbackForms.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  status: text('status').notNull().default('published'),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('feedback_form_versions_form_version_key').on(t.formId, t.version),
  check('feedback_form_versions_status_check', sql`${t.status} IN ('published', 'archived')`),
]);

export const feedbackQuestions = pgTable('feedback_questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  versionId: uuid('version_id').notNull().references(() => feedbackFormVersions.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  label: text('label').notNull(),
  type: text('type').notNull(),
  required: boolean('required').notNull().default(false),
  position: integer('position').notNull(),
  options: jsonb('options').$type<string[]>(),
}, (t) => [
  uniqueIndex('feedback_questions_version_key_key').on(t.versionId, t.key),
  uniqueIndex('feedback_questions_version_position_key').on(t.versionId, t.position),
  check('feedback_questions_type_check', sql`${t.type} IN ('text','textarea','rating','single_choice','multi_choice','boolean')`),
]);

