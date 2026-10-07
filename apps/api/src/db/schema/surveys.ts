import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { branches } from './branches';
import { customers } from './customers';
import { consentGrants } from './consent-grants';

export const SURVEY_OWNER_TYPES = ['platform', 'business'] as const;
export type SurveyOwnerType = (typeof SURVEY_OWNER_TYPES)[number];

export const SURVEY_STATUSES = ['draft', 'published', 'paused', 'closed', 'archived'] as const;
export type SurveyStatus = (typeof SURVEY_STATUSES)[number];

export const SURVEY_VERSION_STATUSES = ['draft', 'published', 'archived'] as const;
export type SurveyVersionStatus = (typeof SURVEY_VERSION_STATUSES)[number];

export const SURVEY_QUESTION_TYPES = [
  'text',
  'textarea',
  'rating',
  'single_choice',
  'multi_choice',
  'boolean',
  'number',
] as const;
export type SurveyQuestionType = (typeof SURVEY_QUESTION_TYPES)[number];

export const SURVEY_CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'closed'] as const;
export type SurveyCampaignStatus = (typeof SURVEY_CAMPAIGN_STATUSES)[number];

export const SURVEY_AUDIENCE_CLASSES = [
  'customer',
  'community_candidate',
  'community_member',
  'business_member',
  'general_authenticated_participant',
] as const;
export type SurveyAudienceClass = (typeof SURVEY_AUDIENCE_CLASSES)[number];

export const SURVEY_REPEAT_POLICIES = ['once', 'once_per_campaign', 'repeatable'] as const;
export type SurveyRepeatPolicy = (typeof SURVEY_REPEAT_POLICIES)[number];

export const SURVEY_PARTICIPATION_STATUSES = [
  'started',
  'submitted',
  'completed',
  'invalidated',
] as const;
export type SurveyParticipationStatus = (typeof SURVEY_PARTICIPATION_STATUSES)[number];

export const SURVEY_PARTICIPATION_SOURCES = [
  'direct',
  'business_qr',
  'customer_qr',
  'link',
  'staff_assisted',
  'other',
] as const;
export type SurveyParticipationSource = (typeof SURVEY_PARTICIPATION_SOURCES)[number];

export const surveys = pgTable(
  'surveys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerType: text('owner_type').$type<SurveyOwnerType>().notNull(),
    businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status').$type<SurveyStatus>().notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (table) => [
    index('surveys_business_status_idx').on(table.businessId, table.status),
    index('surveys_owner_status_idx').on(table.ownerType, table.status),
    check('surveys_owner_type_check', sql`${table.ownerType} IN ('platform','business')`),
    check(
      'surveys_owner_business_check',
      sql`(${table.ownerType} = 'platform' AND ${table.businessId} IS NULL) OR (${table.ownerType} = 'business' AND ${table.businessId} IS NOT NULL)`,
    ),
    check(
      'surveys_status_check',
      sql`${table.status} IN ('draft','published','paused','closed','archived')`,
    ),
  ],
);

export const surveyVersions = pgTable(
  'survey_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    surveyId: uuid('survey_id').notNull().references(() => surveys.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status').$type<SurveyVersionStatus>().notNull().default('draft'),
    title: text('title').notNull(),
    description: text('description'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (table) => [
    uniqueIndex('survey_versions_survey_version_key').on(table.surveyId, table.version),
    index('survey_versions_survey_status_idx').on(table.surveyId, table.status),
    check(
      'survey_versions_status_check',
      sql`${table.status} IN ('draft','published','archived')`,
    ),
    check(
      'survey_versions_published_at_check',
      sql`${table.status} <> 'published' OR ${table.publishedAt} IS NOT NULL`,
    ),
  ],
);

export const surveyQuestions = pgTable(
  'survey_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    versionId: uuid('version_id').notNull().references(() => surveyVersions.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type').$type<SurveyQuestionType>().notNull(),
    required: boolean('required').notNull().default(false),
    position: integer('position').notNull(),
    options: jsonb('options').$type<string[]>(),
    validation: jsonb('validation').$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex('survey_questions_version_key_key').on(table.versionId, table.key),
    uniqueIndex('survey_questions_version_position_key').on(table.versionId, table.position),
    check(
      'survey_questions_type_check',
      sql`${table.type} IN ('text','textarea','rating','single_choice','multi_choice','boolean','number')`,
    ),
    check('survey_questions_position_check', sql`${table.position} >= 0`),
  ],
);

export const surveyCampaigns = pgTable(
  'survey_campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    surveyId: uuid('survey_id').notNull().references(() => surveys.id, { onDelete: 'cascade' }),
    surveyVersionId: uuid('survey_version_id')
      .notNull()
      .references(() => surveyVersions.id, { onDelete: 'restrict' }),
    businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status').$type<SurveyCampaignStatus>().notNull().default('draft'),
    audienceClass: text('audience_class').$type<SurveyAudienceClass>().notNull(),
    repeatPolicy: text('repeat_policy').$type<SurveyRepeatPolicy>().notNull().default('once_per_campaign'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    maxResponses: integer('max_responses'),
    exposeInQrResolver: boolean('expose_in_qr_resolver').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (table) => [
    index('survey_campaigns_survey_status_idx').on(table.surveyId, table.status),
    index('survey_campaigns_business_status_idx').on(table.businessId, table.status),
    index('survey_campaigns_branch_status_idx').on(table.branchId, table.status),
    index('survey_campaigns_window_idx').on(table.startsAt, table.endsAt),
    check(
      'survey_campaigns_status_check',
      sql`${table.status} IN ('draft','active','paused','closed')`,
    ),
    check(
      'survey_campaigns_audience_class_check',
      sql`${table.audienceClass} IN ('customer','community_candidate','community_member','business_member','general_authenticated_participant')`,
    ),
    check(
      'survey_campaigns_repeat_policy_check',
      sql`${table.repeatPolicy} IN ('once','once_per_campaign','repeatable')`,
    ),
    check(
      'survey_campaigns_branch_business_check',
      sql`${table.branchId} IS NULL OR ${table.businessId} IS NOT NULL`,
    ),
    check(
      'survey_campaigns_window_check',
      sql`${table.startsAt} IS NULL OR ${table.endsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`,
    ),
    check(
      'survey_campaigns_max_responses_check',
      sql`${table.maxResponses} IS NULL OR ${table.maxResponses} > 0`,
    ),
  ],
);

export const surveyParticipations = pgTable(
  'survey_participations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    surveyId: uuid('survey_id').notNull().references(() => surveys.id, { onDelete: 'restrict' }),
    surveyVersionId: uuid('survey_version_id')
      .notNull()
      .references(() => surveyVersions.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => surveyCampaigns.id, { onDelete: 'restrict' }),
    participantCustomerId: uuid('participant_customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'set null' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    consentGrantId: uuid('consent_grant_id').references(() => consentGrants.id, { onDelete: 'set null' }),
    status: text('status').$type<SurveyParticipationStatus>().notNull().default('started'),
    idempotencyKey: text('idempotency_key').notNull(),
    submissionPayloadHash: text('submission_payload_hash'),
    source: text('source').$type<SurveyParticipationSource>().notNull().default('direct'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('survey_participations_campaign_idempotency_key').on(
      table.campaignId,
      table.idempotencyKey,
    ),
    index('survey_participations_customer_status_idx').on(table.participantCustomerId, table.status),
    index('survey_participations_campaign_status_idx').on(table.campaignId, table.status),
    index('survey_participations_business_status_idx').on(table.businessId, table.status),
    index('survey_participations_completed_idx').on(table.completedAt),
    check(
      'survey_participations_status_check',
      sql`${table.status} IN ('started','submitted','completed','invalidated')`,
    ),
    check(
      'survey_participations_source_check',
      sql`${table.source} IN ('direct','business_qr','customer_qr','link','staff_assisted','other')`,
    ),
    check(
      'survey_participations_branch_business_check',
      sql`${table.branchId} IS NULL OR ${table.businessId} IS NOT NULL`,
    ),
    check(
      'survey_participations_completion_check',
      sql`${table.status} <> 'completed' OR ${table.completedAt} IS NOT NULL`,
    ),
    check(
      'survey_participations_invalidation_check',
      sql`${table.status} <> 'invalidated' OR ${table.invalidatedAt} IS NOT NULL`,
    ),
  ],
);

export const surveyAnswers = pgTable(
  'survey_answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participationId: uuid('participation_id')
      .notNull()
      .references(() => surveyParticipations.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => surveyQuestions.id, { onDelete: 'restrict' }),
    questionKey: text('question_key').notNull(),
    questionLabel: text('question_label').notNull(),
    questionType: text('question_type').$type<SurveyQuestionType>().notNull(),
    value: jsonb('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('survey_answers_participation_question_key').on(
      table.participationId,
      table.questionId,
    ),
    index('survey_answers_participation_idx').on(table.participationId),
    check(
      'survey_answers_question_type_check',
      sql`${table.questionType} IN ('text','textarea','rating','single_choice','multi_choice','boolean','number')`,
    ),
  ],
);
