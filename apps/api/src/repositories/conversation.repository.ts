import { eq, and, sql, desc } from 'drizzle-orm';
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
  async listForCustomer(customerId: string, options: { limit?: number; offset?: number } = {}): Promise<ConversationWithBusiness[]> {
    const rows = await this.db
      .select({
        conversation: conversations,
        business: { id: sql<string>`businesses.id`, name: sql<string>`businesses.name` },
        unreadCount: unreadCountFrom('staff'),
      })
      .from(conversations)
      .innerJoin(sql`businesses`, sql`businesses.id = ${conversations.businessId}`)
      .where(and(eq(conversations.customerId, customerId), eq(conversations.isDeleted, false)))
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
      .limit(options.limit ?? 100)
      .offset(options.offset ?? 0);

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

  /** Unread customer messages across a business (the staff menu badge). One aggregate, backed by the
   * (conversation_id, sender_type, read_at) index; deleted conversations never count. */
  async unreadSummaryForBusiness(businessId: string): Promise<{ unreadMessages: number; unreadConversations: number }> {
    const [row] = await this.db
      .select({
        unreadMessages: sql<number>`count(${messages.id})::int`,
        unreadConversations: sql<number>`count(DISTINCT ${messages.conversationId})::int`,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          eq(conversations.businessId, businessId),
          eq(conversations.isDeleted, false),
          eq(messages.senderType, 'customer'),
          sql`${messages.readAt} IS NULL`,
        ),
      );
    return { unreadMessages: row?.unreadMessages ?? 0, unreadConversations: row?.unreadConversations ?? 0 };
  }

  /** Unread staff messages for one customer, per business (the customer badge and the wallet card marks). */
  async unreadSummaryForCustomer(
    customerId: string,
  ): Promise<{ businessId: string; unreadMessages: number }[]> {
    const rows = await this.db
      .select({
        businessId: conversations.businessId,
        unreadMessages: sql<number>`count(${messages.id})::int`,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          eq(conversations.customerId, customerId),
          eq(conversations.isDeleted, false),
          eq(messages.senderType, 'staff'),
          sql`${messages.readAt} IS NULL`,
        ),
      )
      .groupBy(conversations.businessId);
    return rows;
  }
}
