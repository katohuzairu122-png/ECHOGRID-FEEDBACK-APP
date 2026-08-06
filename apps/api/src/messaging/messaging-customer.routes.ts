import { Hono, type Context } from 'hono';
import { sendMessageSchema } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import { createRepositories } from '../repositories';
import { customerAuthenticate, type CustomerAuthVariables } from '../middleware/customer-authenticate';
import { rateLimit } from '../middleware/rate-limit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { ConversationService } from './conversation.service';
import { NotificationService } from '../notifications/notification.service';

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

/**
 * Customer-facing side of the messaging module, mounted at /messaging/me --
 * guarded by customerAuthenticate, never the staff authenticate/
 * resolveTenantContext pair, same split as loyaltyCustomerRoutes. Also
 * carries PUBLIC_RATE_LIMITER, same reasoning as loyaltyCustomerRoutes.
 */
export const messagingCustomerRoutes = new Hono<Env>();

messagingCustomerRoutes.use('*', customerAuthenticate, rateLimit('PUBLIC_RATE_LIMITER'));

async function withDb<T>(c: Context<Env>, fn: (db: Database) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(db);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

messagingCustomerRoutes.get('/conversations', async (c) => {
  return withDb(c, async (db) => {
    const items = await new ConversationService(db).listForCustomer(c.get('customerId'));
    return ok(c, items);
  });
});

messagingCustomerRoutes.get('/conversations/:businessId', async (c) => {
  return withDb(c, async (db) => {
    const conversation = await new ConversationService(db).getForCustomerByBusiness(
      c.get('customerId'),
      c.req.param('businessId'),
    );
    if (!conversation) {
      // Absence is a normal state here, not a broken route -- staff simply
      // hasn't messaged this customer yet (see conversation-service's
      // one-way-initiation comment). The caller (web) renders an empty
      // state for this, not a 404 page.
      throw new AppError('No conversation with this business yet.', 404, 'CONVERSATION_NOT_FOUND');
    }
    return ok(c, conversation);
  });
});

messagingCustomerRoutes.get('/conversations/:businessId/messages', async (c) => {
  return withDb(c, async (db) => {
    const items = await new ConversationService(db).getMessagesForCustomer(
      c.get('customerId'),
      c.req.param('businessId'),
    );
    return ok(c, items);
  });
});

messagingCustomerRoutes.post('/conversations/:businessId/read', async (c) => {
  return withDb(c, async (db) => {
    await new ConversationService(db).markReadByCustomer(c.get('customerId'), c.req.param('businessId'));
    return c.body(null, 204);
  });
});

/** A customer can only reply -- 404s if staff hasn't started the
 * conversation yet, matching the confirmed one-way-initiation direction. */
messagingCustomerRoutes.post('/conversations/:businessId/messages', async (c) => {
  const body = await parseJsonBody(c.req.raw, sendMessageSchema);
  const customerId = c.get('customerId');
  const businessId = c.req.param('businessId');
  return withDb(c, async (db) => {
    const repos = createRepositories(db);
    const message = await new ConversationService(db).sendAsCustomer(customerId, businessId, body.body);

    c.executionCtx.waitUntil(
      (async () => {
        const [customer, business] = await Promise.all([
          repos.customers.findById(customerId),
          repos.businesses.findById(businessId),
        ]);
        if (!customer || !business) return;
        const notifications = new NotificationService(repos, c.env.JOBS);
        await notifications.notifyBusinessStaff(
          businessId,
          {
            eventType: 'message_reply_received',
            businessName: business.name,
            customerLabel: customer.fullName ?? customer.phone,
            preview: body.body.slice(0, 100),
          },
          'messages:view',
        );
      })(),
    );

    return ok(c, message, 201);
  });
});
