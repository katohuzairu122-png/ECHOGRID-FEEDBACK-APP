import { pgTable, uuid, text, boolean, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { customers } from './customers';
import { dropReservations, dropSponsorships } from './drops';
import { shuffleCampaignVersions, shuffleEntries, shuffleSelectionResults } from './shuffle';

/**
 * TSH-04 selection -> allocation INTEGRATION (synthetic only). One row records that ONE selected entry of a recorded selection received ONE reservation/allocation on a Drops
 * sponsorship. It is PROVENANCE, not a second ledger: the unit's state machine and the inventory stay on drop_reservations/drop_inventory. Selection, reservation, allocation and
 * collection remain distinct events. synthetic = true is a CHECK, versions stay not_released, and rows are append-only (an allocation is never withdrawn through this table).
 */
export const shuffleDropAllocations = pgTable(
  'shuffle_drop_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    selectionResultId: uuid('selection_result_id').notNull().references(() => shuffleSelectionResults.id, { onDelete: 'restrict' }),
    campaignVersionId: uuid('campaign_version_id').notNull().references(() => shuffleCampaignVersions.id, { onDelete: 'restrict' }),
    entryId: uuid('entry_id').notNull().references(() => shuffleEntries.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
    sponsorshipId: uuid('sponsorship_id').notNull().references(() => dropSponsorships.id, { onDelete: 'restrict' }),
    reservationId: uuid('reservation_id').notNull().references(() => dropReservations.id, { onDelete: 'restrict' }),
    synthetic: boolean('synthetic').notNull().default(true),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('shuffle_drop_allocations_entry_uq').on(t.entryId),
    uniqueIndex('shuffle_drop_allocations_reservation_uq').on(t.reservationId),
    index('shuffle_drop_allocations_version_idx').on(t.campaignVersionId, t.sponsorshipId),
    check('shuffle_drop_allocations_synthetic', sql`${t.synthetic} = true`),
  ],
);
