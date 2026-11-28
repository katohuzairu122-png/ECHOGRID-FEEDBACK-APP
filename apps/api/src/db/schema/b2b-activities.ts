import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { users } from './users';
import { b2bPartnerships } from './b2b-network';

/** Business-scoped in-app inbox. It cannot deliver email, SMS, push, or customer advertising. */
export const b2bNotifications = pgTable(
  'b2b_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipientBusinessId: uuid('recipient_business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    eventKey: text('event_key').notNull(),
    eventType: text('event_type').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('b2b_notifications_event_key_uq').on(t.eventKey),
    index('b2b_notifications_recipient_created_idx').on(t.recipientBusinessId, t.createdAt),
    check(
      'b2b_notifications_event_type_valid',
      sql`${t.eventType} IN ('request_received','request_accepted','request_rejected','request_cancelled','request_expired','partnership_established','partnership_terminated','message_received','proposal_received','proposal_responded','moderation_action')`,
    ),
    check(
      'b2b_notifications_resource_type_valid',
      sql`${t.resourceType} IN ('request','partnership','message','proposal','moderation')`,
    ),
    check(
      'b2b_notifications_subject_length',
      sql`char_length(btrim(${t.subject})) BETWEEN 1 AND 120`,
    ),
    check('b2b_notifications_body_length', sql`char_length(btrim(${t.body})) BETWEEN 1 AND 500`),
  ],
);

export const b2bNotificationReads = pgTable(
  'b2b_notification_reads',
  {
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => b2bNotifications.id, { onDelete: 'restrict' }),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('b2b_notification_reads_once_uq').on(t.notificationId, t.userId),
    index('b2b_notification_reads_business_idx').on(t.businessId, t.userId),
  ],
);

/** One partnership conversation. Access is derived from the live partnership, never from a cached membership list. */
export const b2bMessages = pgTable(
  'b2b_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partnershipId: uuid('partnership_id')
      .notNull()
      .references(() => b2bPartnerships.id, { onDelete: 'restrict' }),
    senderBusinessId: uuid('sender_business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    senderUserId: uuid('sender_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('b2b_messages_conversation_idx').on(t.partnershipId, t.createdAt, t.id),
    check('b2b_messages_body_length', sql`char_length(btrim(${t.body})) BETWEEN 1 AND 4000`),
  ],
);

export const b2bMessageReads = pgTable(
  'b2b_message_reads',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => b2bMessages.id, { onDelete: 'restrict' }),
    partnershipId: uuid('partnership_id')
      .notNull()
      .references(() => b2bPartnerships.id, { onDelete: 'restrict' }),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('b2b_message_reads_once_uq').on(t.messageId, t.userId),
    index('b2b_message_reads_unread_idx').on(t.partnershipId, t.businessId, t.userId),
  ],
);

/** Informal, explicitly non-binding collaboration proposals. No price, payment, liability, or customer data fields. */
export const b2bProposals = pgTable(
  'b2b_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partnershipId: uuid('partnership_id')
      .notNull()
      .references(() => b2bPartnerships.id, { onDelete: 'restrict' }),
    proposerBusinessId: uuid('proposer_business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    description: text('description').notNull(),
    status: text('status').notNull().default('pending'),
    respondedByUserId: uuid('responded_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('b2b_proposals_partnership_idx').on(t.partnershipId, t.createdAt),
    check(
      'b2b_proposals_status_valid',
      sql`${t.status} IN ('pending','accepted','declined','withdrawn')`,
    ),
    check('b2b_proposals_title_length', sql`char_length(btrim(${t.title})) BETWEEN 1 AND 120`),
    check(
      'b2b_proposals_description_length',
      sql`char_length(btrim(${t.description})) BETWEEN 1 AND 2000`,
    ),
    check(
      'b2b_proposals_response_evidence',
      sql`(${t.status} = 'accepted' OR ${t.status} = 'declined') = (${t.respondedAt} IS NOT NULL AND ${t.respondedByUserId} IS NOT NULL)`,
    ),
    check(
      'b2b_proposals_withdrawn_evidence',
      sql`(${t.status} = 'withdrawn') = (${t.withdrawnAt} IS NOT NULL)`,
    ),
  ],
);

export const b2bProposalEvents = pgTable(
  'b2b_proposal_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => b2bProposals.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    actorBusinessId: uuid('actor_business_id').references(() => businesses.id, {
      onDelete: 'restrict',
    }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('b2b_proposal_events_proposal_idx').on(t.proposalId, t.createdAt),
    check(
      'b2b_proposal_events_type_valid',
      sql`${t.eventType} IN ('created','accepted','declined','withdrawn')`,
    ),
    check(
      'b2b_proposal_events_actor_pair',
      sql`(${t.actorBusinessId} IS NULL) = (${t.actorUserId} IS NULL)`,
    ),
  ],
);

export const b2bAbuseReports = pgTable(
  'b2b_abuse_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reporterBusinessId: uuid('reporter_business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    reporterUserId: uuid('reporter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    targetBusinessId: uuid('target_business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id').notNull(),
    reasonCode: text('reason_code').notNull(),
    details: text('details'),
    status: text('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('b2b_abuse_reports_open_idx').on(t.status, t.createdAt),
    index('b2b_abuse_reports_reporter_idx').on(t.reporterBusinessId, t.createdAt),
    check('b2b_abuse_reports_not_self', sql`${t.reporterBusinessId} <> ${t.targetBusinessId}`),
    check(
      'b2b_abuse_reports_resource_valid',
      sql`${t.resourceType} IN ('business','request','partnership','message','proposal')`,
    ),
    check(
      'b2b_abuse_reports_reason_valid',
      sql`${t.reasonCode} IN ('spam','harassment','misrepresentation','unauthorized_content','other')`,
    ),
    check(
      'b2b_abuse_reports_status_valid',
      sql`${t.status} IN ('open','reviewing','resolved','dismissed')`,
    ),
    check(
      'b2b_abuse_reports_details_length',
      sql`${t.details} IS NULL OR char_length(${t.details}) <= 1000`,
    ),
  ],
);

export const b2bModerationActions = pgTable(
  'b2b_moderation_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetBusinessId: uuid('target_business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    actionType: text('action_type').notNull(),
    reasonCode: text('reason_code').notNull(),
    reason: text('reason').notNull(),
    relatedReportId: uuid('related_report_id').references(() => b2bAbuseReports.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('b2b_moderation_actions_business_idx').on(t.targetBusinessId, t.createdAt),
    check(
      'b2b_moderation_actions_type_valid',
      sql`${t.actionType} IN ('restrict_participation','restore_participation','suspend_partnership','reinstate_partnership')`,
    ),
    check('b2b_moderation_actions_reason_code_valid', sql`${t.reasonCode} ~ '^[A-Z_]{3,40}$'`),
    check(
      'b2b_moderation_actions_reason_length',
      sql`char_length(btrim(${t.reason})) BETWEEN 1 AND 1000`,
    ),
  ],
);
