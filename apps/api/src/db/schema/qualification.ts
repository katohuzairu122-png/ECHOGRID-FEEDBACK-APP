import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';
import { businesses } from './businesses';
import { users } from './users';

export const QUALIFICATION_PARTICIPANT_TYPES = ['customer', 'business'] as const;
export const QUALIFICATION_APPROVAL_STATES = ['draft', 'approved', 'retired'] as const;
export type QualificationApprovalState = (typeof QUALIFICATION_APPROVAL_STATES)[number];

/**
 * TSH-02 / QUAL-PURCHASE-01: the SHARED qualification rule store (TSH-01 section 4). One closed, declarative spec format serves Tentaship Badges,
 * Shuffle and Drops: no second engine. A version is IMMUTABLE content. `approval_state` starts `draft`; moving it to `approved` is a policy act
 * (the Owner's definition of a verified referral / qualifying purchase) that NO route in this block performs, so nothing can qualify in production
 * until an approved version exists. Approval is recorded with who and when; retiring is final.
 */
export const qualificationRuleVersions = pgTable(
  'qualification_rule_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ruleKey: text('rule_key').notNull(),
    version: integer('version').notNull(),
    participantType: text('participant_type').notNull(),
    spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),
    specHash: text('spec_hash').notNull(),
    approvalState: text('approval_state').$type<QualificationApprovalState>().notNull().default('draft'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('qualification_rule_versions_key_version_uq').on(t.ruleKey, t.version),
    uniqueIndex('qualification_rule_versions_one_approved_idx').on(t.ruleKey).where(sql`${t.approvalState} = 'approved'`),
    check('qualification_rule_versions_key_format', sql`${t.ruleKey} ~ '^[a-z][a-z0-9_]{2,63}$'`),
    check('qualification_rule_versions_participant_valid', sql`${t.participantType} IN ('customer','business')`),
    check('qualification_rule_versions_state_valid', sql`${t.approvalState} IN ('draft','approved','retired')`),
    check('qualification_rule_versions_version_positive', sql`${t.version} >= 1`),
    check('qualification_rule_versions_hash_format', sql`${t.specHash} ~ '^[0-9a-f]{64}$'`),
    check('qualification_rule_versions_approval_shape', sql`(${t.approvalState} = 'draft' AND ${t.approvedAt} IS NULL AND ${t.retiredAt} IS NULL) OR (${t.approvalState} = 'approved' AND ${t.approvedAt} IS NOT NULL AND ${t.approvedByUserId} IS NOT NULL AND ${t.retiredAt} IS NULL) OR (${t.approvalState} = 'retired' AND ${t.retiredAt} IS NOT NULL)`),
  ],
);

/** A piece of evidence consumed by ONE qualification under ONE rule version (duplicate-qualification prevention). Append-only. */
export const qualificationEvidenceConsumptions = pgTable(
  'qualification_evidence_consumptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    evidenceKind: text('evidence_kind').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    ruleVersionId: uuid('rule_version_id').notNull().references(() => qualificationRuleVersions.id, { onDelete: 'restrict' }),
    consumerKind: text('consumer_kind').notNull(),
    consumerRef: text('consumer_ref').notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('qualification_consumptions_once_uq').on(t.evidenceKind, t.evidenceId, t.ruleVersionId, t.consumerKind),
    index('qualification_consumptions_consumer_idx').on(t.consumerKind, t.consumerRef),
    check('qualification_consumptions_kind_valid', sql`${t.evidenceKind} IN ('purchase_event','referral','badge_award') AND ${t.consumerKind} IN ('referral','badge','campaign')`),
  ],
);

export const REFERRAL_TYPES = ['business_invitation', 'customer_referral'] as const;
export type ReferralType = (typeof REFERRAL_TYPES)[number];
export const REFERRAL_PROVENANCE_KINDS = ['owner_invitation', 'cashier_assisted_invitation', 'customer_referral_token'] as const;
export const REFERRAL_EVENT_TYPES = ['attributed', 'pending_qualification', 'verified', 'expired', 'rejected', 'invalidated', 'revoked', 'fraud_review'] as const;
export type ReferralEventType = (typeof REFERRAL_EVENT_TYPES)[number];

/**
 * The immutable ATTRIBUTION of one referred customer (TSH-02). At most ONE attribution per referred customer, ever: no re-attribution, no
 * existence-recycling. Organic and unattributed acquisition have NO row (absence is the fact). A `business_invitation` is an acquisition channel
 * owned by a business and is NEVER a customer referral; a `customer_referral` needs a referring customer distinct from the referred one.
 */
export const customerReferrals = pgTable(
  'customer_referrals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    referralType: text('referral_type').$type<ReferralType>().notNull(),
    referringCustomerId: uuid('referring_customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    referredCustomerId: uuid('referred_customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
    businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'restrict' }),
    provenanceKind: text('provenance_kind').notNull(),
    /** The server-side record that proves the source (invitation id / onboarding event reference). Never a client value. */
    provenanceRef: text('provenance_ref').notNull(),
    attributedAt: timestamp('attributed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('customer_referrals_referred_once_uq').on(t.referredCustomerId),
    uniqueIndex('customer_referrals_provenance_uq').on(t.provenanceKind, t.provenanceRef),
    index('customer_referrals_referrer_idx').on(t.referringCustomerId),
    index('customer_referrals_business_idx').on(t.businessId, t.attributedAt),
    check('customer_referrals_type_valid', sql`${t.referralType} IN ('business_invitation','customer_referral')`),
    check('customer_referrals_provenance_valid', sql`${t.provenanceKind} IN ('owner_invitation','cashier_assisted_invitation','customer_referral_token')`),
    check('customer_referrals_no_self', sql`${t.referringCustomerId} IS NULL OR ${t.referringCustomerId} <> ${t.referredCustomerId}`),
    check('customer_referrals_shape', sql`(${t.referralType} = 'business_invitation' AND ${t.referringCustomerId} IS NULL AND ${t.businessId} IS NOT NULL AND ${t.provenanceKind} IN ('owner_invitation','cashier_assisted_invitation')) OR (${t.referralType} = 'customer_referral' AND ${t.referringCustomerId} IS NOT NULL AND ${t.provenanceKind} = 'customer_referral_token')`),
  ],
);

/** APPEND-ONLY lifecycle of a referral. The current state is the highest `seq`. The database validates every transition. */
export const customerReferralEvents = pgTable(
  'customer_referral_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    referralId: uuid('referral_id').notNull().references(() => customerReferrals.id, { onDelete: 'restrict' }),
    seq: integer('seq').notNull(),
    eventType: text('event_type').$type<ReferralEventType>().notNull(),
    reasonCode: text('reason_code'),
    /** Aggregate facts only (e.g. newToPlatform, qualifying purchase evidence ids). No customer content. */
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    ruleVersionId: uuid('rule_version_id').references(() => qualificationRuleVersions.id, { onDelete: 'restrict' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('customer_referral_events_seq_uq').on(t.referralId, t.seq),
    uniqueIndex('customer_referral_events_one_verified_uq').on(t.referralId).where(sql`${t.eventType} = 'verified'`),
    index('customer_referral_events_referral_idx').on(t.referralId, t.seq),
    check('customer_referral_events_type_valid', sql`${t.eventType} IN ('attributed','pending_qualification','verified','expired','rejected','invalidated','revoked','fraud_review')`),
    check('customer_referral_events_seq_positive', sql`${t.seq} >= 1`),
    check('customer_referral_events_verified_has_rule', sql`${t.eventType} <> 'verified' OR ${t.ruleVersionId} IS NOT NULL`),
  ],
);
