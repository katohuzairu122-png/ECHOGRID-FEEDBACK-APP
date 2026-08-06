import { eq, and, isNull, desc } from 'drizzle-orm';
import { messages } from '../db/schema';
import { BaseRepository } from './base.repository';

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export class MessageRepository extends BaseRepository {
  async listForConversation(
    conversationId: string,
    options: { limit?: number | undefined; offset?: number | undefined } = {},
  ): Promise<Message[]> {
    return this.db.query.messages.findMany({
      where: eq(messages.conversationId, conversationId),
      limit: options.limit,
      offset: options.offset,
      orderBy: desc(messages.createdAt),
    });
  }

  async create(input: NewMessage): Promise<Message> {
    const [row] = await this.db.insert(messages).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /** Marks every unread message sent by the OTHER party as read -- never the
   * viewer's own sent messages. viewerType is the viewer's own role, so this
   * flips the opposite senderType. */
  async markReadForRecipient(conversationId: string, viewerType: 'staff' | 'customer'): Promise<void> {
    const otherSenderType = viewerType === 'staff' ? 'customer' : 'staff';
    await this.db
      .update(messages)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.senderType, otherSenderType),
          isNull(messages.readAt),
        ),
      );
  }
}
