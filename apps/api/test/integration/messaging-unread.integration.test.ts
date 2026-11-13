import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { eq, inArray } from 'drizzle-orm';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { ConversationService } from '../../src/messaging/conversation.service';
import {
  businesses,
  conversations,
  customers,
  loyaltyAccounts,
  messages,
} from '../../src/db/schema';

/**
 * Unread counts for the menu badge, against a real database. "Unread" means sent by the other party and not yet
 * read by the viewer. Never point DATABASE_URL at production: this creates and deletes real rows.
 */
describe.skipIf(!process.env.DATABASE_URL)('messaging unread summaries (integration)', () => {
  let client: Client;
  let db: ReturnType<typeof buildDb>;
  let service: ConversationService;
  const suffix = crypto.randomUUID().slice(0, 8);
  const staff = crypto.randomUUID();
  let bizA: string;
  let bizB: string;
  let ana: string;
  let ben: string;
  let loner: string;
  let convAnaA: string;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    db = buildDb(client);
    service = new ConversationService(db);
    const repos = createRepositories(db);
    bizA = (await repos.businesses.create({ name: `Unread A ${suffix}`, slug: `unr-a-${suffix}` }))
      .id;
    bizB = (await repos.businesses.create({ name: `Unread B ${suffix}`, slug: `unr-b-${suffix}` }))
      .id;
    const phone = (n: number) => `+158${n}${Math.floor(Math.random() * 900_000 + 100_000)}`;
    ana = (await repos.customers.create({ phone: phone(1), phoneVerifiedAt: new Date() })).id;
    ben = (await repos.customers.create({ phone: phone(2), phoneVerifiedAt: new Date() })).id;
    loner = (await repos.customers.create({ phone: phone(3), phoneVerifiedAt: new Date() })).id;
    for (const [c, b] of [
      [ana, bizA],
      [ana, bizB],
      [ben, bizA],
    ] as const) {
      await repos.loyaltyAccounts.create({ customerId: c, businessId: b });
    }

    convAnaA = (await service.getOrCreateForCustomer(bizA, ana, staff)).id;
    const convAnaB = (await service.getOrCreateForCustomer(bizB, ana, staff)).id;
    const convBenA = (await service.getOrCreateForCustomer(bizA, ben, staff)).id;

    // Ana at A: business sent 2, Ana replied 1.  Ana at B: business sent 1.  Ben at A: business sent 1, Ben replied 2.
    await service.sendAsStaff(bizA, convAnaA, staff, 'A to Ana, 1');
    await service.sendAsStaff(bizA, convAnaA, staff, 'A to Ana, 2');
    await service.sendAsCustomer(ana, bizA, 'Ana to A');
    await service.sendAsStaff(bizB, convAnaB, staff, 'B to Ana');
    await service.sendAsStaff(bizA, convBenA, staff, 'A to Ben');
    await service.sendAsCustomer(ben, bizA, 'Ben to A, 1');
    await service.sendAsCustomer(ben, bizA, 'Ben to A, 2');
  });

  afterAll(async () => {
    const convs = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(inArray(conversations.businessId, [bizA, bizB]));
    if (convs.length)
      await db.delete(messages).where(
        inArray(
          messages.conversationId,
          convs.map((c) => c.id),
        ),
      );
    await db.delete(conversations).where(inArray(conversations.businessId, [bizA, bizB]));
    await db.delete(loyaltyAccounts).where(inArray(loyaltyAccounts.businessId, [bizA, bizB]));
    await db.delete(customers).where(inArray(customers.id, [ana, ben, loner]));
    await db.delete(businesses).where(inArray(businesses.id, [bizA, bizB]));
    await client.end();
  });

  it('counts a business’s unread customer messages and the conversations they are in', async () => {
    expect(await service.unreadSummaryForStaff(bizA)).toEqual({
      unreadMessages: 3,
      unreadConversations: 2,
    });
  });

  it('does not count messages the business sent itself, and shows nothing for a business with no customer replies', async () => {
    expect(await service.unreadSummaryForStaff(bizB)).toEqual({
      unreadMessages: 0,
      unreadConversations: 0,
    });
  });

  it('counts a customer’s unread business messages in total and per business', async () => {
    const summary = await service.unreadSummaryForCustomer(ana);
    expect(summary.unreadMessages).toBe(3);
    expect(summary.unreadConversations).toBe(2);
    expect(
      Object.fromEntries(summary.byBusiness.map((b) => [b.businessId, b.unreadMessages])),
    ).toEqual({
      [bizA]: 2,
      [bizB]: 1,
    });
  });

  it('is empty for a customer nobody has messaged', async () => {
    expect(await service.unreadSummaryForCustomer(loner)).toEqual({
      unreadMessages: 0,
      unreadConversations: 0,
      byBusiness: [],
    });
  });

  it('never mixes customers: Ben’s unread are separate from Ana’s', async () => {
    const summary = await service.unreadSummaryForCustomer(ben);
    expect(summary).toMatchObject({ unreadMessages: 1, unreadConversations: 1 });
    expect(summary.byBusiness).toEqual([{ businessId: bizA, unreadMessages: 1 }]);
  });

  it('drops the counts once each side has read the thread', async () => {
    await service.markReadByStaff(bizA, convAnaA);
    expect(await service.unreadSummaryForStaff(bizA)).toEqual({
      unreadMessages: 2,
      unreadConversations: 1,
    });

    await service.markReadByCustomer(ana, bizA);
    const after = await service.unreadSummaryForCustomer(ana);
    expect(after.unreadMessages).toBe(1);
    expect(after.byBusiness).toEqual([{ businessId: bizB, unreadMessages: 1 }]);
  });

  it('ignores deleted conversations', async () => {
    await db
      .update(conversations)
      .set({ isDeleted: true })
      .where(eq(conversations.businessId, bizB));
    expect(await service.unreadSummaryForCustomer(ana)).toEqual({
      unreadMessages: 0,
      unreadConversations: 0,
      byBusiness: [],
    });
  });
});
