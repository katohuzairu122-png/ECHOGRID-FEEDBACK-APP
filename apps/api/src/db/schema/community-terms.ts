import { pgTable, uuid, text, jsonb, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Legal publications, never a second consent ledger. Empty until separately approved. */
export const communityTermsPublications = pgTable('community_terms_publications', {
  id: uuid('id').primaryKey(),
  version: text('version').notNull().unique(),
  publication: jsonb('publication').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('community_terms_identity_check', sql`${t.publication}->>'id' = ${t.id}::text AND ${t.publication}->>'version' = ${t.version} AND ${t.publication}->>'purpose' = 'community_membership'`)]);

export const communityTermsCurrent = pgTable('community_terms_current', {
  purpose: text('purpose').primaryKey(),
  publicationId: uuid('publication_id').references(() => communityTermsPublications.id, { onDelete: 'restrict' }),
}, (t) => [check('community_terms_current_purpose_check', sql`${t.purpose} = 'community_membership'`)]);
