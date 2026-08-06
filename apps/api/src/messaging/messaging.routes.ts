import { Hono, type Context } from 'hono';
import { sendMessageSchema, createConversationSchema } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { runInBackground } from '../lib/background-db';
import { ConversationService } from './conversation.service';
import { NotificationService } from '../notifications/notification.service';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & TenantVariables & AuditVariables;
};

/**
 * Staff-facing side of the messaging module -- every route needs tenant
 * context, same shape as loyaltyRoutes. Split from
 * messaging-customer.routes.ts (mounted separately at /messaging/me)
 * because the two use entirely different auth: staff JWT + RBAC here,
 * customer JWT there.
 */
export const messagingRoutes = new Hono<Env>();

messagingRoutes.use('*', authenticate, resolveTenantContext);

async function withDb<T>(c: Context<Env>, fn: (db: Database) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(db);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

messagingRoutes.get('/conversations', requirePermission('messages:view'), async (c) => {
  const url = new URL(c.req.url);
  const limit = Number(url.searchParams.get('limit')) || undefined;
  const offset = Number(url.searchParams.get('offset')) || undefined;
  return withDb(c, async (db) => {
    const items = await new ConversationService(db).listForBusiness(c.get('businessId'), { limit, offset });
    return ok(c, items);
  });
});

/** The entry point staff uses to start a thread with an already-enrolled
 * loyalty customer (see conversations.ts's schema comment for why this v1
 * scope excludes non-enrolled feedback submitters). Idempotent -- returns
 * the existing conversation if one already exists. Gated on messages:send,
 * not messages:view, since starting a conversation is a write action. */
messagingRoutes.post('/conversations', requirePermission('messages:send'), async (c) => {
  const body = await parseJsonBody(c.req.raw, createConversationSchema);
  return withDb(c, async (db) => {
    const conversation = await new ConversationService(db).getOrCreateForCustomer(
      c.get('businessId'),
      body.customerId,
      c.get('userId'),
    );
    return ok(c, conversation, 201);
  });
});

messagingRoutes.get('/conversations/:id', requirePermission('messages:view'), async (c) => {
  return withDb(c, async (db) => {
    const conversation = await new ConversationService(db).getForStaff(c.get('businessId'), c.req.param('id'));
    return ok(c, conversation);
  });
});

/** Does NOT mark messages as read as a side effect of listing them -- that's
 * a separate, explicit POST .../read, so a staff member merely fetching the
 * list (e.g. for a badge count) never silently clears someone else's unread
 * state. */
messagingRoutes.get('/conversations/:id/messages', requirePermission('messages:view'), async (c) => {
  return withDb(c, async (db) => {
    const items = await new ConversationService(db).getMessagesForStaff(c.get('businessId'), c.req.param('id'));
    return ok(c, items);
  });
});

messagingRoutes.post('/conversations/:id/read', requirePermission('messages:view'), async (c) => {
  return withDb(c, async (db) => {
    await new ConversationService(db).markReadByStaff(c.get('businessId'), c.req.param('id'));
    return c.body(null, 204);
  });
});

messagingRoutes.post('/conversations/:id/messages', requirePermission('messages:send'), async (c) => {
  const body = await parseJsonBody(c.req.raw, sendMessageSchema);
  const businessId = c.get('businessId');
  const conversationId = c.req.param('id');
  return withDb(c, async (db) => {
    const message = await new ConversationService(db).sendAsStaff(businessId, conversationId, c.get('userId'), body.body);
    c.set('auditMetadata', { action: 'messaging.message_sent', entityType: 'conversation', entityId: conversationId });

    // Notification trigger runs AFTER the send has already succeeded, never
    // inside it -- same "never notify about something that didn't actually
    // happen" ordering every other trigger in this codebase follows. Uses
    // its own fresh connection (runInBackground), not the outer `db` --
    // see that helper's doc comment for why reusing it races withDb's own
    // close().
    c.executionCtx.waitUntil(
      runInBackground(c.env.HYPERDRIVE, async (repos) => {
        const [conversation, business] = await Promise.all([
          repos.conversations.findById(conversationId, businessId),
          repos.businesses.findById(businessId),
        ]);
        if (!conversation || !business) return;
        const notifications = new NotificationService(repos, c.env.JOBS);
        await notifications.notify(
          businessId,
          { customerId: conversation.customerId },
          { eventType: 'message_received', businessName: business.name, preview: body.body.slice(0, 100) },
        );
      }),
    );

    return ok(c, message, 201);
  });
});
