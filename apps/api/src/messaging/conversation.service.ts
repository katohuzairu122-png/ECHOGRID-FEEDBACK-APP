import type { Database } from '../db/client';
import { createRepositories, type Repositories, type Conversation, type Message } from '../repositories';
import { AppError } from '../lib/errors';

/**
 * Handles both the staff and customer sides of one conversation, mirroring
 * LoyaltyAccountService's own staff+customer split (listForBusiness/
 * listForCustomer, getSummary). Constructor-injected with the raw Database
 * (not Repositories) so getOrCreateForCustomer can open a transaction, same
 * exception LoyaltyAccountService.enroll takes for the same
 * find-or-create-avoids-a-race reason.
 */
export class ConversationService {
  constructor(private readonly db: Database) {}

  // ---- Staff ----------------------------------------------------------

  async listForBusiness(
    businessId: string,
    options: { limit?: number | undefined; offset?: number | undefined } = {},
  ) {
    const repos = createRepositories(this.db);
    return repos.conversations.listForBusiness(businessId, options);
  }

  /** Single-conversation detail (customer name/phone + unread count) for the
   * thread page's header -- distinct from requireConversation below, which
   * returns the bare row without the joined customer identity. */
  async getForStaff(businessId: string, conversationId: string) {
    const repos = createRepositories(this.db);
    const conversation = await repos.conversations.findByIdWithCustomer(conversationId, businessId);
    if (!conversation) {
      throw new AppError('Conversation not found.', 404, 'CONVERSATION_NOT_FOUND');
    }
    return conversation;
  }

  /** Idempotent -- returns the existing conversation if staff has already
   * started one with this customer, same "find existing, else create"
   * pattern as LoyaltyAccountService.enroll, for the same race-avoidance
   * reason (the unique (customerId, businessId) index alone isn't enough to
   * avoid two concurrent requests both attempting the insert). */
  async getOrCreateForCustomer(businessId: string, customerId: string, createdBy: string): Promise<Conversation> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const existing = await repos.conversations.findByCustomerAndBusiness(customerId, businessId);
      if (existing) return existing;
      return repos.conversations.create({ businessId, customerId, createdBy });
    });
  }

  async getMessagesForStaff(businessId: string, conversationId: string): Promise<Message[]> {
    const repos = createRepositories(this.db);
    await this.requireConversation(repos, conversationId, businessId);
    return repos.messages.listForConversation(conversationId);
  }

  async markReadByStaff(businessId: string, conversationId: string): Promise<void> {
    const repos = createRepositories(this.db);
    await this.requireConversation(repos, conversationId, businessId);
    await repos.messages.markReadForRecipient(conversationId, 'staff');
  }

  async sendAsStaff(
    businessId: string,
    conversationId: string,
    userId: string,
    body: string,
  ): Promise<Message> {
    const repos = createRepositories(this.db);
    const conversation = await this.requireConversation(repos, conversationId, businessId);
    const message = await repos.messages.create({
      conversationId: conversation.id,
      senderType: 'staff',
      senderId: userId,
      body,
    });
    await repos.conversations.touch(conversation.id, body, message.createdAt);
    return message;
  }

  // ---- Customer ---------------------------------------------------------

  async getForCustomerByBusiness(customerId: string, businessId: string): Promise<Conversation | undefined> {
    const repos = createRepositories(this.db);
    return repos.conversations.findByCustomerAndBusiness(customerId, businessId);
  }

  async listForCustomer(customerId: string) {
    const repos = createRepositories(this.db);
    return repos.conversations.listForCustomer(customerId);
  }

  async getMessagesForCustomer(customerId: string, businessId: string): Promise<Message[]> {
    const repos = createRepositories(this.db);
    const conversation = await this.requireConversationForCustomer(repos, customerId, businessId);
    return repos.messages.listForConversation(conversation.id);
  }

  async markReadByCustomer(customerId: string, businessId: string): Promise<void> {
    const repos = createRepositories(this.db);
    const conversation = await this.requireConversationForCustomer(repos, customerId, businessId);
    await repos.messages.markReadForRecipient(conversation.id, 'customer');
  }

  /** A customer can only reply, never cold-start a conversation -- 404 if
   * staff hasn't messaged them yet, matching the confirmed "staff sends,
   * customer replies" one-way-initiation direction. */
  async sendAsCustomer(customerId: string, businessId: string, body: string): Promise<Message> {
    const repos = createRepositories(this.db);
    const conversation = await this.requireConversationForCustomer(repos, customerId, businessId);
    const message = await repos.messages.create({
      conversationId: conversation.id,
      senderType: 'customer',
      senderId: customerId,
      body,
    });
    await repos.conversations.touch(conversation.id, body, message.createdAt);
    return message;
  }

  // ---- Shared -------------------------------------------------------------

  private async requireConversation(
    repos: Repositories,
    conversationId: string,
    businessId: string,
  ): Promise<Conversation> {
    const conversation = await repos.conversations.findById(conversationId, businessId);
    if (!conversation) {
      throw new AppError('Conversation not found.', 404, 'CONVERSATION_NOT_FOUND');
    }
    return conversation;
  }

  private async requireConversationForCustomer(
    repos: Repositories,
    customerId: string,
    businessId: string,
  ): Promise<Conversation> {
    const conversation = await repos.conversations.findByCustomerAndBusiness(customerId, businessId);
    if (!conversation) {
      throw new AppError('Conversation not found.', 404, 'CONVERSATION_NOT_FOUND');
    }
    return conversation;
  }
}
