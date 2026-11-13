import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { eq, inArray } from 'drizzle-orm';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { ConversationService } from '../../src/messaging/conversation.service';
import {
  conversations,
  loyaltyAccounts,
  messages,
  customers,
  businesses,
} from '../../src/db/schema';
import { AppError } from '../../src/lib/errors';

/**
 * The customer side of messaging, against a real database. Until this file existed the only customer-messaging
 * tests were smoke tests (route mounted, 401 when logged out): nothing exercised "the business has sent a
 * message and the customer opens the thread", which is exactly the path a customer hits in production.
 * Never point DATABASE_URL at production: this creates and deletes real rows.
 */
describe.skipIf(!process.env.DATABASE_URL)('customer messaging thread (integration)', () => {
  let client: Client;
  let db: ReturnType<typeof buildDb>;
  let service: ConversationService;
  const suffix = crypto.randomUUID().slice(0, 8);
  const staffUserId = crypto.randomUUID();
  let businessId: string;
  let otherBusinessId: string;
  let customerId: string;
  let strangerId: string;
  let conversationId: string;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    db = buildDb(client);
    service = new ConversationService(db);
    const repos = createRepositories(db);

    const business = await repos.businesses.create({
      name: `Thread test ${suffix}`,
      slug: `thread-${suffix}`,
    });
    const other = await repos.businesses.create({
      name: `Thread other ${suffix}`,
      slug: `thread-o-${suffix}`,
    });
    businessId = business.id;
    otherBusinessId = other.id;
    const customer = await repos.customers.create({
      phone: `+1570${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
      phoneVerifiedAt: new Date(),
      fullName: 'Amina Okafor',
    });
    const stranger = await repos.customers.create({
      phone: `+1571${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
      phoneVerifiedAt: new Date(),
    });
    customerId = customer.id;
    strangerId = stranger.id;
    await repos.loyaltyAccounts.create({ customerId, businessId });

    const conversation = await service.getOrCreateForCustomer(businessId, customerId, staffUserId);
    conversationId = conversation.id;
    await service.sendAsStaff(businessId, conversationId, staffUserId, 'Welcome to the programme.');
    await service.sendAsStaff(businessId, conversationId, staffUserId, 'Your reward is ready.');
  });

  afterAll(async () => {
    if (conversationId)
      await db.delete(messages).where(eq(messages.conversationId, conversationId));
    await db.delete(conversations).where(eq(conversations.businessId, businessId));
    await db.delete(loyaltyAccounts).where(eq(loyaltyAccounts.businessId, businessId));
    await db.delete(customers).where(inArray(customers.id, [customerId, strangerId]));
    await db.delete(businesses).where(inArray(businesses.id, [businessId, otherBusinessId]));
    await client.end();
  });

  it('lets the customer find the conversation the business started', async () => {
    const found = await service.getForCustomerByBusiness(customerId, businessId);
    expect(found?.id).toBe(conversationId);
  });

  it('lists the customer’s conversations with the business name and the unread count from staff', async () => {
    const list = await service.listForCustomer(customerId);
    const entry = list.find((c) => c.id === conversationId);
    expect(entry).toBeDefined();
    expect(entry!.business.name).toBe(`Thread test ${suffix}`);
    expect(Number(entry!.unreadCount)).toBe(2);
  });

  it('returns the staff messages to the customer, newest first, with the page size the web page uses (100)', async () => {
    const thread = await service.getMessagesForCustomer(customerId, businessId, {
      limit: 100,
      offset: 0,
    });
    expect(thread.map((m) => m.body)).toEqual([
      'Your reward is ready.',
      'Welcome to the programme.',
    ]);
    expect(thread.every((m) => m.senderType === 'staff')).toBe(true);
    expect(thread.every((m) => m.createdAt instanceof Date)).toBe(true);
  });

  it('marks the staff messages read for the customer, and the unread count drops to zero', async () => {
    await service.markReadByCustomer(customerId, businessId);
    const entry = (await service.listForCustomer(customerId)).find((c) => c.id === conversationId);
    expect(Number(entry!.unreadCount)).toBe(0);
  });

  it('lets the customer reply, and the reply shows in the thread', async () => {
    const reply = await service.sendAsCustomer(customerId, businessId, 'Thank you!');
    expect(reply.senderType).toBe('customer');
    const thread = await service.getMessagesForCustomer(customerId, businessId, {
      limit: 100,
      offset: 0,
    });
    expect(thread[0]!.body).toBe('Thank you!');
  });

  it('shows nothing of this thread to another customer or in another business', async () => {
    await expect(service.getMessagesForCustomer(strangerId, businessId)).rejects.toMatchObject({
      status: 404,
      code: 'CONVERSATION_NOT_FOUND',
    });
    await expect(service.markReadByCustomer(customerId, otherBusinessId)).rejects.toBeInstanceOf(
      AppError,
    );
    expect(await service.getForCustomerByBusiness(strangerId, businessId)).toBeUndefined();
  });
});

/**
 * The same flow through the real Worker (every global middleware, the customer login check, the rate limiters and the
 * response envelope), which is what the web page actually calls. Rate limiters are stubbed to "allowed" here: their
 * counting is Cloudflare's, and is covered separately.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  'customer messaging thread through the Worker (integration)',
  () => {
    let client: Client;
    let db: ReturnType<typeof buildDb>;
    const suffix = crypto.randomUUID().slice(0, 8);
    const staffUserId = crypto.randomUUID();
    const SECRET = 'thread-worker-test-secret';
    let businessId: string;
    let customerId: string;
    let token: string;

    const limiter = { limit: async () => ({ success: true }) };
    const env = () =>
      ({
        HYPERDRIVE: { connectionString: process.env.DATABASE_URL! },
        CUSTOMER_JWT_SECRET: SECRET,
        JWT_ACCESS_SECRET: 'unused-access-secret',
        QR_TOKEN_SECRET: 'unused-qr-secret',
        ENVIRONMENT: 'development',
        ALLOWED_ORIGINS: 'http://localhost:3000',
        API_RATE_LIMITER: limiter,
        PUBLIC_RATE_LIMITER: limiter,
        AUTH_RATE_LIMITER: limiter,
        OTP_RATE_LIMITER: limiter,
      }) as never;
    const ctx = {
      waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined),
      passThroughOnException() {},
    } as never;

    type Envelope = { success?: boolean; data?: unknown; error?: { code?: string } };

    async function call(path: string, init: RequestInit = {}) {
      const { default: worker } = await import('../../src/index');
      const response = await worker.fetch(
        new Request(`http://localhost/api/v1${path}`, {
          ...init,
          headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
        }),
        env(),
        ctx,
      );
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as Envelope) : null };
    }

    beforeAll(async () => {
      const { signCustomerAccessToken } = await import('../../src/customer-auth/customer-jwt');
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      db = buildDb(client);
      const repos = createRepositories(db);
      const business = await repos.businesses.create({
        name: `Worker thread ${suffix}`,
        slug: `wthread-${suffix}`,
      });
      businessId = business.id;
      const customer = await repos.customers.create({
        phone: `+1572${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
        fullName: 'Amina Okafor',
      });
      customerId = customer.id;
      await repos.loyaltyAccounts.create({ customerId, businessId });
      const service = new ConversationService(db);
      const conversation = await service.getOrCreateForCustomer(
        businessId,
        customerId,
        staffUserId,
      );
      await service.sendAsStaff(
        businessId,
        conversation.id,
        staffUserId,
        'Welcome to the programme.',
      );
      await service.sendAsStaff(businessId, conversation.id, staffUserId, 'Your reward is ready.');
      token = await signCustomerAccessToken(customerId, SECRET);
    });

    afterAll(async () => {
      await db.delete(conversations).where(eq(conversations.businessId, businessId));
      await db.delete(loyaltyAccounts).where(eq(loyaltyAccounts.businessId, businessId));
      await db.delete(customers).where(eq(customers.id, customerId));
      await db.delete(businesses).where(eq(businesses.id, businessId));
      await client.end();
    });

    it('answers the three calls the customer thread page makes, in the order it makes them', async () => {
      const conversation = await call(`/messaging/me/conversations/${businessId}`);
      expect(conversation.status).toBe(200);
      expect(conversation.body?.success).toBe(true);

      const read = await call(`/messaging/me/conversations/${businessId}/read`, { method: 'POST' });
      expect(read.status).toBe(204);

      const thread = await call(
        `/messaging/me/conversations/${businessId}/messages?limit=100&offset=0`,
      );
      expect(thread.status).toBe(200);
      expect((thread.body?.data as { body: string }[]).map((m) => m.body)).toEqual([
        'Your reward is ready.',
        'Welcome to the programme.',
      ]);
    });

    it('answers 404 for a business that has not messaged this customer (the page shows its empty state)', async () => {
      const { status, body } = await call(`/messaging/me/conversations/${crypto.randomUUID()}`);
      expect(status).toBe(404);
      expect(body?.error?.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('lists the customer’s conversations', async () => {
      const { status, body } = await call('/messaging/me/conversations');
      expect(status).toBe(200);
      expect(
        (body?.data as { business: { name: string } }[]).some(
          (c) => c.business.name === `Worker thread ${suffix}`,
        ),
      ).toBe(true);
    });
  },
);
