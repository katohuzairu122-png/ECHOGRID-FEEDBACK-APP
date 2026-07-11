import { pgTable, uuid, text, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns, softDeleteColumns } from './_shared';
import { businesses } from './businesses';
import { branches } from './branches';

/**
 * A scannable public entry point into one branch's feedback flow. `token`
 * (not `id`) is what's encoded in the actual QR image -- deliberately
 * short and separate from the row's own UUID: a shorter payload makes a
 * denser-safe, more reliable-to-scan QR code, and regenerating (revoke
 * this row, create a new one) never touches the branch's real id or any
 * of its foreign-key references. No server-side QR image is generated or
 * stored anywhere (not even R2) -- the row is just an opaque token; the
 * scannable image is rendered client-side from it (Block 4).
 *
 * `type` always `'feedback'` today -- QR-driven loyalty check-ins and
 * promotions are later modules, not designed yet. The column exists now so
 * adding a real second type later is a data migration, not a schema one.
 * No CHECK constraint on it yet, on purpose: the full set of future values
 * isn't designed, and a single known value today is trivially enforced in
 * application code without DB-level help -- a constraint added ahead of
 * that design would just be guessing at it. `status` is a genuine CHECK
 * candidate, unlike `type`, because both its values are fully known today.
 */
export const qrCodes = pgTable(
  'qr_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    type: text('type').notNull().default('feedback'),
    status: text('status').notNull().default('active'),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (table) => [
    // At most one ACTIVE code per branch per type, enforced at the database
    // level -- not just by application logic in the regenerate flow (revoke
    // old, create new). Mirrors user_business_roles' partial unique indexes:
    // a safety net against a future bug or a race between two concurrent
    // regenerate requests, not something a fake-repository unit test could
    // ever verify on its own.
    uniqueIndex('qr_codes_branch_type_active_key')
      .on(table.branchId, table.type)
      .where(sql`${table.status} = 'active'`),
    check('qr_codes_status_check', sql`${table.status} IN ('active', 'revoked')`),
  ],
);
