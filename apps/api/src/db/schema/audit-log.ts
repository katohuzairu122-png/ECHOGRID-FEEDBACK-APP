import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { businesses } from './businesses';
import { users } from './users';

/**
 * Append-only audit trail. No updatedAt/isDeleted on purpose -- rows are
 * never modified after insert. businessId/actorUserId use ON DELETE SET
 * NULL (unlike every other FK in this schema, which cascades) so the log
 * survives even if the business or user it references is later purged,
 * which compliance retention requires. The auto-capture write path is
 * Block 8.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'set null' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(), // namespaced, e.g. "user.role_granted"
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    metadata: jsonb('metadata'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_business_id_created_at_idx').on(table.businessId, table.createdAt),
    index('audit_log_entity_idx').on(table.entityType, table.entityId),
    index('audit_log_actor_user_id_created_at_idx').on(table.actorUserId, table.createdAt),
  ],
);
