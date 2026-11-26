import { pgTable, uuid, text, integer, timestamp, jsonb, boolean, index, uniqueIndex, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { customers } from './customers';
import { users } from './users';
import { qualificationRuleVersions } from './qualification';

export const DROP_SPONSORSHIP_STATUSES = ['draft', 'submitted', 'under_review', 'approved', 'scheduled', 'available', 'suspended', 'cancelled', 'expired'] as const;
export type DropSponsorshipStatus = (typeof DROP_SPONSORSHIP_STATUSES)[number];
export const DROP_RESERVATION_STATUSES = ['reserved', 'allocated', 'collected', 'released', 'expired'] as const;
export type DropReservationStatus = (typeof DROP_RESERVATION_STATUSES)[number];

/**
 * TDP-02 (Tentaship Drops sponsorship + atomic inventory). TWO SEPARATE STATE MACHINES (TDP-01 section 7): the sponsorship (offer) status here and the
 * reservation/allocation status on `drop_reservations`. SYNTHETIC-ONLY and PAYMENT-FREE by construction: `synthetic = true` is a CHECK, there is no price,
 * payment, tax, fee or fulfilment-obligation column anywhere, and no customer-facing or sponsor-facing route exists in this block. A sponsorship is owned
 * by one business (tenant); only a platform reviewer who is NOT its creator can approve it (database-enforced separation of duties).
 */
export const dropSponsorships = pgTable(
  'drop_sponsorships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
    status: text('status').$type<DropSponsorshipStatus>().notNull().default('draft'),
    statusReason: text('status_reason'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    approvedVersionId: uuid('approved_version_id'),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    synthetic: boolean('synthetic').notNull().default(true),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('drop_sponsorships_key_uq').on(t.key),
    index('drop_sponsorships_business_idx').on(t.businessId, t.status),
    check('drop_sponsorships_key_format', sql`${t.key} ~ '^[a-z][a-z0-9_]{2,63}$'`),
    check('drop_sponsorships_status_valid', sql`${t.status} IN ('draft','submitted','under_review','approved','scheduled','available','suspended','cancelled','expired')`),
    check('drop_sponsorships_synthetic', sql`${t.synthetic} = true`),
    check('drop_sponsorships_review_shape', sql`(${t.reviewedByUserId} IS NULL) = (${t.reviewedAt} IS NULL)`),
  ],
);

/** IMMUTABLE sponsorship definition (descriptive only: no price, payment, tax or obligation fields exist). Versions only while the sponsorship is a draft. */
export const dropSponsorshipVersions = pgTable(
  'drop_sponsorship_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sponsorshipId: uuid('sponsorship_id').notNull().references(() => dropSponsorships.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    productName: text('product_name').notNull(),
    description: text('description').notNull(),
    quantityTotal: integer('quantity_total').notNull(),
    eligibleParticipantType: text('eligible_participant_type').notNull().default('customer'),
    collectionMethod: text('collection_method').notNull(),
    collectionLocation: text('collection_location').notNull(),
    collectionWindowStart: timestamp('collection_window_start', { withTimezone: true }).notNull(),
    collectionWindowEnd: timestamp('collection_window_end', { withTimezone: true }).notNull(),
    offerExpiresAt: timestamp('offer_expires_at', { withTimezone: true }).notNull(),
    /** The shared qualification rule version (APPROVED at use) that decides eligibility: one engine. */
    qualificationRuleVersionId: uuid('qualification_rule_version_id').notNull().references(() => qualificationRuleVersions.id, { onDelete: 'restrict' }),
    contentHash: text('content_hash').notNull(),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('drop_sponsorship_versions_uq').on(t.sponsorshipId, t.version),
    unique('drop_sponsorship_versions_id_sponsorship_uq').on(t.id, t.sponsorshipId),
    check('drop_versions_quantity', sql`${t.quantityTotal} >= 1 AND ${t.quantityTotal} <= 1000000`), // 1,000,000 is a technical sanity bound, not a business term
    check('drop_versions_participant', sql`${t.eligibleParticipantType} = 'customer'`),
    check('drop_versions_windows', sql`${t.collectionWindowEnd} > ${t.collectionWindowStart} AND ${t.offerExpiresAt} > ${t.createdAt}`),
    check('drop_versions_text', sql`char_length(${t.productName}) BETWEEN 1 AND 120 AND char_length(${t.description}) BETWEEN 1 AND 1000 AND char_length(${t.collectionMethod}) BETWEEN 1 AND 300 AND char_length(${t.collectionLocation}) BETWEEN 1 AND 300`),
    check('drop_versions_hash', sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** ONE authoritative inventory row per sponsorship. Counters change ONLY through the reservation trigger; the sum can never exceed the total (CHECK). */
export const dropInventory = pgTable(
  'drop_inventory',
  {
    sponsorshipId: uuid('sponsorship_id').primaryKey().references(() => dropSponsorships.id, { onDelete: 'restrict' }),
    totalQuantity: integer('total_quantity').notNull(),
    reserved: integer('reserved').notNull().default(0),
    allocated: integer('allocated').notNull().default(0),
    collected: integer('collected').notNull().default(0),
    expired: integer('expired').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('drop_inventory_non_negative', sql`${t.totalQuantity} >= 1 AND ${t.reserved} >= 0 AND ${t.allocated} >= 0 AND ${t.collected} >= 0 AND ${t.expired} >= 0`),
    check('drop_inventory_no_oversubscription', sql`${t.reserved} + ${t.allocated} + ${t.collected} + ${t.expired} <= ${t.totalQuantity}`),
  ],
);

/** The allocation (unit) state machine: reserved -> allocated -> collected; reserved -> released|expired; allocated -> expired. One per customer per sponsorship. */
export const dropReservations = pgTable(
  'drop_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sponsorshipId: uuid('sponsorship_id').notNull().references(() => dropSponsorships.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
    status: text('status').$type<DropReservationStatus>().notNull().default('reserved'),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }).notNull(),
    eligibilityEvidence: jsonb('eligibility_evidence').$type<Record<string, unknown>>().notNull(),
    statusReason: text('status_reason'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    synthetic: boolean('synthetic').notNull().default(true),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('drop_reservations_once_uq').on(t.sponsorshipId, t.customerId),
    index('drop_reservations_status_idx').on(t.sponsorshipId, t.status),
    check('drop_reservations_status_valid', sql`${t.status} IN ('reserved','allocated','collected','released','expired')`),
    check('drop_reservations_synthetic', sql`${t.synthetic} = true`),
  ],
);

/** Hash-chained append-only evidence per sponsorship (linkage enforced by trigger). */
export const dropEvents = pgTable(
  'drop_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sponsorshipId: uuid('sponsorship_id').notNull().references(() => dropSponsorships.id, { onDelete: 'restrict' }),
    seq: integer('seq').notNull(),
    prevHash: text('prev_hash'),
    hash: text('hash').notNull(),
    event: jsonb('event').$type<Record<string, unknown>>().notNull(),
    actorUserId: uuid('actor_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('drop_events_seq_uq').on(t.sponsorshipId, t.seq),
    check('drop_events_hash', sql`${t.hash} ~ '^[0-9a-f]{64}$' AND (${t.prevHash} IS NULL OR ${t.prevHash} ~ '^[0-9a-f]{64}$') AND ${t.seq} >= 1 AND ((${t.seq} = 1) = (${t.prevHash} IS NULL))`),
  ],
);
