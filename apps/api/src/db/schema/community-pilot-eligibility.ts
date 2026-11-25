import { pgTable, uuid, text, timestamp, bigint, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';
import { users } from './users';

export const COMMUNITY_PILOT_ACTIONS = ['grant', 'revoke'] as const;
export type CommunityPilotAction = (typeof COMMUNITY_PILOT_ACTIONS)[number];

/**
 * COMMUNITY pilot allowlist, as an append-only event history. A customer is eligible only while the LATEST event (highest seq) is a
 * 'grant'. Nothing is ever updated or deleted (database guard), so every eligibility change stays auditable. The staff actor and a
 * mandatory reason are recorded. This table is independent of the Community Feed controls and of consent: it never authorizes
 * anything by itself, it is only one of the conditions for a membership activation.
 */
export const communityPilotEligibilityEvents = pgTable(
  'community_pilot_eligibility_events',
  {
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
    action: text('action').$type<CommunityPilotAction>().notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('community_pilot_events_customer_seq_idx').on(t.customerId, t.seq),
    check('community_pilot_events_action_check', sql`${t.action} IN ('grant', 'revoke')`),
    check('community_pilot_events_reason_check', sql`length(btrim(${t.reason})) BETWEEN 1 AND 500`),
  ],
);
