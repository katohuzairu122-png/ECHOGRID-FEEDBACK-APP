import { eq, and, sql } from 'drizzle-orm';
import { conversations, messages } from '../db/schema';
import type { Customer } from './customer.repository';
import type { Business } from './business.repository';
import { BaseRepository } from './base.repository';

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;

export type ConversationWithCustomer = Conversation & {
  customer: Pick<Customer, 'id' | 'phone' | 'fullName'>;
  unreadCount: number;
};

export type ConversationWithBusiness = Conversation & {
  business: Pick<Business, 'id' | 'name'>;
  unreadCount: number;
};

/** Subquery counting unread messages FROM the given sender type -- shared by
 * both list methods below since "unread" always means "unread by the viewer,
 * i.e. sent by the OTHER party." */
function unreadCountFrom(fromSenderType: 'staff' | 'customer') {
  return sql<number>`(
    SELECT count(*)::int FROM ${messages}
    WHERE ${messages.conversationId} = ${conversations.id}
      AND ${messages.senderType} = ${fromSenderType}
      AND ${messages.readAt} IS NULL
  )`;
}

export class ConversationRepository extends BaseRepository {
  async findById(id: string, businessId: string): Promise<Conversation | undefined> {
    return this.db.query.conversations.findFirst({
      where: and(
        eq(conversations.id, id),
        eq(conversations.businessId, businessId),
        eq(conversations.isDeleted, false),
      ),
    });
  }

  /** Single-row counterpart to listForBusiness's join -- the thread page
   * needs the customer's name/phone for its header, not just the message
   * list. */
  async findByIdWithCustomer(id: string, businessId: string): Promise<ConversationWithCustomer | undefined> {
    const [row] = await this.db
      .select({
        conversation: conversations,
        customer: { id: sql<string>`customers.id`, phone: sql<string>`customers.phone`, fullName: sql<string | null>`customers.full_name` },
        unreadCount: unreadCountFrom('customer'),
      })
      .from(conversations)
      .innerJoin(sql`customers`, sql`customers.id = ${conversations.customerId}`)
      .where(and(eq(conversations.id, id), eq(conversations.businessId, businessId), eq(conversations.isDeleted, false)))
      .limit(1);

    return row ? { ...row.conversation, customer: row.customer, unreadCount: row.unreadCount } : undefined;
  }

  async findByCustomerAndBusiness(
    customerId: string,
    businessId: string,
  ): Promise<Conversation | undefined> {
    return this.db.query.conversations.findFirst({
      where: and(
        eq(conversations.customerId, customerId),
        eq(conversations.businessId, businessId),
        eq(conversations.isDeleted, false),
      ),
    });
  }

  /** Staff-facing list -- unread means unread messages sent BY the customer. */
  async listForBusiness(
    businessId: string,
    options: { limit?: number | undefined; offset?: number | undefined } = {},
  ): Promise<ConversationWithCustomer[]> {
    const rows = await this.db
      .select({
        conversation: conversations,
        customer: { id: sql<string>`customers.id`, phone: sql<string>`customers.phone`, fullName: sql<string | null>`customers.full_name` },
        unreadCount: unreadCountFrom('customer'),
      })
      .from(conversations)
      .innerJoin(sql`customers`, sql`customers.id = ${conversations.customerId}`)
      .where(and(eq(conversations.businessId, businessId), eq(conversations.isDeleted, false)))
      .orderBy(sql`${conversations.lastMessageAt} desc`)
      .limit(options.limit ?? 1000)
      .offset(options.offset ?? 0);

    return rows.map((r) => ({ ...r.conversation, customer: r.customer, unreadCount: r.unreadCount }));
  }

  /** Customer's own view, across every business -- no businessId scoping on
   * purpose, same reasoning as LoyaltyAccountRepository.listForCustomer.
   * Unread means unread messages sent BY staff. */
  async listForCustomer(customerId: string): Promise<ConversationWithBusiness[]> {
    const rows = await this.db
      .select({
        conversation: conversations,
        business: { id: sql<string>`businesses.id`, name: sql<string>`businesses.name` },
        unreadCount: unreadCountFrom('staff'),
      })
      .from(conversations)
      .innerJoin(sql`businesses`, sql`businesses.id = ${conversations.businessId}`)
      .where(and(eq(conversations.customerId, customerId), eq(conversations.isDeleted, false)))
      .orderBy(sql`${conversations.lastMessageAt} desc`);

    return rows.map((r) => ({ ...r.conversation, business: r.business, unreadCount: r.unreadCount }));
  }

  async create(input: NewConversation): Promise<Conversation> {
    const [row] = await this.db.insert(conversations).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /** Denormalized preview fields, updated alongside every new message --
   * same tradeoff as LoyaltyAccountRepository.applyPointsDelta. */
  async touch(id: string, preview: string, at: Date): Promise<Conversation> {
    const [row] = await this.db
      .update(conversations)
      .set({ lastMessageAt: at, lastMessagePreview: preview, updatedAt: new Date() })
      .where(eq(conversations.id, id))
      .returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }
}
