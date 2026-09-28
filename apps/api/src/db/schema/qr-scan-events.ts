import { pgTable, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { businesses } from './businesses';
import { branches } from './branches';
import { qrCodes } from './qr-codes';

/**
 * Privacy-minimized scan analytics. `clientHash` is a salted server-side
 * digest; the raw browser signal is never persisted. A unique bucket key
 * makes deduplication atomic under concurrent page loads.
 */
export const qrScanEvents = pgTable(
  'qr_scan_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull().references(() => branches.id, { onDelete: 'cascade' }),
    qrCodeId: uuid('qr_code_id').notNull().references(() => qrCodes.id, { onDelete: 'cascade' }),
    clientHash: text('client_hash').notNull(),
    dedupBucket: timestamp('dedup_bucket', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('qr_scan_events_qr_client_bucket_key').on(
      table.qrCodeId,
      table.clientHash,
      table.dedupBucket,
    ),
    index('qr_scan_events_business_branch_created_idx').on(
      table.businessId,
      table.branchId,
      table.createdAt,
    ),
  ],
);

