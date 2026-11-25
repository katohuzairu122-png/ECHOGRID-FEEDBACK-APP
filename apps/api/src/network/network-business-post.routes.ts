import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requireBusinessWideAccess } from '../middleware/require-business-wide-access';
import { requirePermission } from '../middleware/require-permission';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { NETWORK_LOCALES } from '../db/schema/network-posts';
import { isBusinessPublishingEnabled } from './network-flag';
import { NetworkBusinessPostService, resolveDailyPostCap } from './network-business-post.service';

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables & AuditVariables };

const contentSchema = z.object({
  body: z.string().max(4000),
  linkUrl: z.string().max(4096).nullish(),
  contentLocale: z.enum(NETWORK_LOCALES),
}).strict();

const HANDLE = /^[A-Za-z0-9_-]{22}$/;

/**
 * BCOMM-03: business-side authoring of Community posts (`/network/business-posts`). Business-wide `network:post` only (Owner and Admin by
 * default; never a cashier or branch-scoped user), always re-resolved from the database by the middleware. Everything that CHANGES anything
 * needs NETWORK_BUSINESS_PUBLISHING_ENABLED (exact "true") and refuses an impersonation session; with the control closed every write answers
 * the generic 404 of an unmounted route, while reading the business's OWN posts and their moderation status stays available, so closing the
 * control never hides or deletes history. The business can never approve, reject, suspend or publish: those are platform moderation only.
 */
export const networkBusinessPostRoutes = new Hono<Env>();

networkBusinessPostRoutes.use('*', authenticate, resolveTenantContext, requireBusinessWideAccess, requirePermission('network:post'));

function writable(c: Context<Env>) {
  if (!isBusinessPublishingEnabled(c.env)) throw new AppError('Not found.', 404, 'NOT_FOUND');
  if (c.get('impersonatedBy')) throw new AppError('An impersonation session cannot change posts.', 403, 'IMPERSONATION_READ_ONLY');
}

async function withService<T>(c: Context<Env>, work: (service: NetworkBusinessPostService) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await work(new NetworkBusinessPostService(db, resolveDailyPostCap(c.env.NETWORK_BUSINESS_DAILY_POST_CAP)));
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

function handleParam(c: Context<Env>): string {
  const handle = c.req.param('handle') ?? '';
  if (!HANDLE.test(handle)) throw new AppError('Not found.', 404, 'NETWORK_NOT_FOUND');
  return handle;
}

// The audit row records WHO did WHAT to WHICH post (internal id) and never the post text.
const audit = async (c: Context<Env>, service: NetworkBusinessPostService, action: string, handle: string) =>
  c.set('auditMetadata', { action, entityType: 'network_post', entityId: await service.idOf(c.get('businessId'), handle) });

networkBusinessPostRoutes.get('/', (c) =>
  withService(c, async (service) => {
    c.header('Cache-Control', 'private, no-store');
    return ok(c, await service.list(c.get('businessId')));
  }));

networkBusinessPostRoutes.get('/:handle', (c) =>
  withService(c, async (service) => {
    c.header('Cache-Control', 'private, no-store');
    return ok(c, await service.get(c.get('businessId'), handleParam(c)));
  }));

networkBusinessPostRoutes.post('/', async (c) => {
  writable(c);
  const body = await parseJsonBody(c.req.raw, contentSchema);
  return withService(c, async (service) => {
    const post = await service.createDraft(c.get('businessId'), c.get('userId') as string, body);
    await audit(c, service, 'network.business_post_draft_created', post.handle);
    return ok(c, post, 201);
  });
});

networkBusinessPostRoutes.put('/:handle/draft', async (c) => {
  writable(c);
  const body = await parseJsonBody(c.req.raw, contentSchema);
  return withService(c, async (service) => {
    const handle = handleParam(c);
    const post = await service.saveDraft(c.get('businessId'), handle, c.get('userId') as string, body);
    await audit(c, service, 'network.business_post_draft_saved', handle);
    return ok(c, post);
  });
});

networkBusinessPostRoutes.post('/:handle/submit', async (c) => {
  writable(c);
  return withService(c, async (service) => {
    const handle = handleParam(c);
    const post = await service.submit(c.get('businessId'), handle);
    await audit(c, service, 'network.business_post_submitted', handle);
    return ok(c, post);
  });
});

networkBusinessPostRoutes.post('/:handle/archive', async (c) => {
  writable(c);
  return withService(c, async (service) => {
    const handle = handleParam(c);
    const post = await service.archive(c.get('businessId'), handle);
    await audit(c, service, 'network.business_post_archived', handle);
    return ok(c, post);
  });
});
