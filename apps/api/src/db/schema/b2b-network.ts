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

/** Split 09 request and relationship records. No customer, loyalty or financial references are present. */
export const B2B_REQUEST_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'cancelled',
  'expired',
] as const;
export type B2bRequestStatus = (typeof B2B_REQUEST_STATUSES)[number];
export const B2B_PARTNERSHIP_STATUSES = ['active', 'suspended', 'terminated'] as const;
export type B2bPartnershipStatus = (typeof B2B_PARTNERSHIP_STATUSES)[number];
export const B2B_REQUEST_EVENT_TYPES = [
  'created',
  'accepted',
  'rejected',
  'cancelled',
  'expired',
] as const;
export type B2bRequestEventType = (typeof B2B_REQUEST_EVENT_TYPES)[number];
export const B2B_PARTNERSHIP_EVENT_TYPES = [
  'established',
  'suspended',
  'reinstated',
  'terminated',
] as const;
export type B2bPartnershipEventType = (typeof B2B_PARTNERSHIP_EVENT_TYPES)[number];

export const b2bPartnershipRequests = pgTable(
  'b2b_partnership_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requesterBusinessId: uuid('requester_business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    targetBusinessId: uuid('target_business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text('status').$type<B2bRequestStatus>().notNull().default('pending'),
    /** Plain-text business-to-business purpose; never interpreted as a contract or financial commitment. */
    reason: text('reason').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    respondedByUserId: uuid('responded_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    responseNote: text('response_note'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('b2b_partnership_requests_idempotency_uq').on(
      t.requesterBusinessId,
      t.idempotencyKey,
    ),
    uniqueIndex('b2b_partnership_requests_one_pending_pair_uq')
      .on(
        sql`LEAST(${t.requesterBusinessId}, ${t.targetBusinessId})`,
        sql`GREATEST(${t.requesterBusinessId}, ${t.targetBusinessId})`,
      )
      .where(sql`${t.status} = 'pending'`),
    index('b2b_partnership_requests_sender_day_idx').on(t.requesterBusinessId, t.createdAt),
    index('b2b_partnership_requests_target_idx').on(t.targetBusinessId, t.status, t.createdAt),
    index('b2b_partnership_requests_cooldown_idx')
      .on(t.requesterBusinessId, t.targetBusinessId, t.respondedAt)
      .where(sql`${t.status} = 'rejected'`),
    check(
      'b2b_partnership_requests_distinct_businesses',
      sql`${t.requesterBusinessId} <> ${t.targetBusinessId}`,
    ),
    check(
      'b2b_partnership_requests_status_valid',
      sql`${t.status} IN ('pending','accepted','rejected','cancelled','expired')`,
    ),
    check(
      'b2b_partnership_requests_reason_length',
      sql`char_length(btrim(${t.reason})) BETWEEN 1 AND 1000`,
    ),
    check(
      'b2b_partnership_requests_idempotency_format',
      sql`${t.idempotencyKey} ~ '^[A-Za-z0-9._:-]{8,128}$'`,
    ),
    check(
      'b2b_partnership_requests_response_state',
      sql`(${t.status} IN ('accepted','rejected')) = (${t.respondedAt} IS NOT NULL AND ${t.respondedByUserId} IS NOT NULL)`,
    ),
    check(
      'b2b_partnership_requests_cancelled_state',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} IS NOT NULL AND ${t.cancelledByUserId} IS NOT NULL)`,
    ),
    check(
      'b2b_partnership_requests_response_note_length',
      sql`${t.responseNote} IS NULL OR char_length(${t.responseNote}) <= 500`,
    ),
  ],
);

/** One record for each accepted request. Businesses are stored in stable UUID order for pair uniqueness. */
export const b2bPartnerships = pgTable(
  'b2b_partnerships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceRequestId: uuid('source_request_id')
      .notNull()
      .unique()
      .references(() => b2bPartnershipRequests.id, { onDelete: 'restrict' }),
    businessAId: uuid('business_a_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    businessBId: uuid('business_b_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    status: text('status').$type<B2bPartnershipStatus>().notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    suspendedByUserId: uuid('suspended_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    suspensionReason: text('suspension_reason'),
    terminatedAt: timestamp('terminated_at', { withTimezone: true }),
    terminatedByBusinessId: uuid('terminated_by_business_id').references(() => businesses.id, {
      onDelete: 'restrict',
    }),
    terminatedByUserId: uuid('terminated_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [
    uniqueIndex('b2b_partnerships_one_live_pair_uq')
      .on(t.businessAId, t.businessBId)
      .where(sql`${t.status} IN ('active','suspended')`),
    index('b2b_partnerships_business_a_idx').on(t.businessAId, t.status, t.createdAt),
    index('b2b_partnerships_business_b_idx').on(t.businessBId, t.status, t.createdAt),
    check('b2b_partnerships_pair_ordered', sql`${t.businessAId} < ${t.businessBId}`),
    check('b2b_partnerships_status_valid', sql`${t.status} IN ('active','suspended','terminated')`),
    check(
      'b2b_partnerships_suspension_evidence',
      sql`(${t.status} = 'suspended') = (${t.suspendedAt} IS NOT NULL AND ${t.suspendedByUserId} IS NOT NULL AND ${t.suspensionReason} IS NOT NULL)`,
    ),
    check(
      'b2b_partnerships_termination_evidence',
      sql`(${t.status} = 'terminated') = (${t.terminatedAt} IS NOT NULL AND ${t.terminatedByBusinessId} IS NOT NULL AND ${t.terminatedByUserId} IS NOT NULL)`,
    ),
    check(
      'b2b_partnerships_suspension_reason_length',
      sql`${t.suspensionReason} IS NULL OR char_length(btrim(${t.suspensionReason})) BETWEEN 1 AND 500`,
    ),
  ],
);

/** Append-only request lifecycle evidence, including system expiration events. */
export const b2bPartnershipRequestEvents = pgTable(
  'b2b_partnership_request_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => b2bPartnershipRequests.id, { onDelete: 'restrict' }),
    eventType: text('event_type').$type<B2bRequestEventType>().notNull(),
    actorBusinessId: uuid('actor_business_id').references(() => businesses.id, {
      onDelete: 'restrict',
    }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('b2b_request_events_request_idx').on(t.requestId, t.createdAt),
    check(
      'b2b_request_events_type_valid',
      sql`${t.eventType} IN ('created','accepted','rejected','cancelled','expired')`,
    ),
    check(
      'b2b_request_events_actor_pair',
      sql`(${t.actorBusinessId} IS NULL) = (${t.actorUserId} IS NULL)`,
    ),
  ],
);

/** Append-only partnership lifecycle evidence. Private message contents never appear in this table. */
export const b2bPartnershipEvents = pgTable(
  'b2b_partnership_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partnershipId: uuid('partnership_id')
      .notNull()
      .references(() => b2bPartnerships.id, { onDelete: 'restrict' }),
    eventType: text('event_type').$type<B2bPartnershipEventType>().notNull(),
    actorBusinessId: uuid('actor_business_id').references(() => businesses.id, {
      onDelete: 'restrict',
    }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('b2b_partnership_events_partnership_idx').on(t.partnershipId, t.createdAt),
    check(
      'b2b_partnership_events_type_valid',
      sql`${t.eventType} IN ('established','suspended','reinstated','terminated')`,
    ),
    check(
      'b2b_partnership_events_actor_pair',
      sql`(${t.actorBusinessId} IS NULL) = (${t.actorUserId} IS NULL)`,
    ),
  ],
);
