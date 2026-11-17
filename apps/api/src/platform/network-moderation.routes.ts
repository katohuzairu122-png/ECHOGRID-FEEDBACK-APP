import { NETWORK_DRAFT_HANDLE } from '@echo-grid-feedback/shared-types';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { requirePlatformRole, type PlatformVariables } from '../middleware/require-platform-role';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { NETWORK_LOCALES } from '../db/schema/network-posts';
import { NetworkPostService, type NetworkPostRow } from '../network/network-post.service';
import { listNetworkModerationHistory } from '../network/network-moderation-history';
import { isNetworkFeedEnabled } from '../network/network-flag';
import { requireNetworkPlatformPermission } from './network-permissions';
import { getNetworkSavedDraft, listNetworkSavedDrafts, type NetworkDraftCursor } from '../network/network-saved-drafts';

type Env = { Bindings: Bindings; Variables: AuthVariables & PlatformVariables & AuditVariables };

const contentSchema = z.object({
  body: z.string().max(4000),
  linkUrl: z.string().max(4096).nullish(),
  contentLocale: z.enum(NETWORK_LOCALES),
}).strict();
const reasonSchema = z.object({ reasonCode: z.string().max(64) }).strict();

const present = (post: NetworkPostRow) => ({
  handle: post.handle,
  state: post.state,
  pinned: post.pinned,
  publishedAt: post.publishedAt?.toISOString() ?? null,
  expiresAt: post.expiresAt?.toISOString() ?? null,
});

/**
 * Platform moderation and official authoring (NETWORK-01). Disabled by default: with the feature flag off every path
 * answers the generic 404 of an unmounted route, before authentication. All routes need a platform `admin`
 * (re-resolved from the database per request; impersonation is refused by requirePlatformRole). Authoring and
 * moderation are separate code-owned permissions; separation of duties (author never approves; two distinct
 * approvers) is enforced in the service and again by database triggers. Audit rows record actor, action and entity.
 */
export function createNetworkModerationRoutes(options: { open?: (c: Context<Env>) => Promise<{ db: Database; release: () => void }> } = {}) {
  const routes = new Hono<Env>();
  const open = options.open ?? (async (c: Context<Env>) => {
    const { db, close } = await createDb(c.env.HYPERDRIVE);
    return { db, release: () => c.executionCtx.waitUntil(close()) };
  });

  routes.use('*', async (c, next) => {
    if (!isNetworkFeedEnabled(c.env)) throw new AppError('Not found.', 404, 'NOT_FOUND');
    await next();
  });
  routes.use('*', authenticate, requirePlatformRole(['support', 'billing', 'admin']));

  async function run<T>(c: Context<Env>, work: (service: NetworkPostService) => Promise<T>): Promise<T> {
    const handle = await open(c);
    try {
      return await work(new NetworkPostService(handle.db));
    } finally {
      handle.release();
    }
  }

  async function postByHandle(service: NetworkPostService, c: Context<Env>): Promise<NetworkPostRow> {
    const post = await service.findByHandle(c.req.param('handle') ?? '');
    if (!post) throw new AppError('Not found.', 404, 'NETWORK_NOT_FOUND');
    return post;
  }

  const audit = (c: Context<Env>, action: string, entityId: string, details?: unknown) =>
    c.set('auditMetadata', { action, entityType: 'network_post', entityId, ...(details !== undefined ? { details } : {}) });

  routes.get('/history', requireNetworkPlatformPermission('network:moderate'), async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const params = new URL(c.req.url).searchParams;
    const cursors = params.getAll('cursor');
    const cursor = cursors[0];
    if (Array.from(params.keys()).some((key) => key !== 'cursor') || cursors.length > 1 ||
        (cursor !== undefined && !z.uuid().safeParse(cursor).success)) {
      throw new AppError('Invalid history pagination.', 400, 'INVALID_HISTORY_PAGINATION');
    }
    const { db, release } = await open(c);
    try {
      return ok(c, await listNetworkModerationHistory(db, cursor));
    } finally {
      release();
    }
  });

  routes.get('/queue', requireNetworkPlatformPermission('network:moderate'), async (c) =>
    run(c, async (service) => {
      const rows = await service.queue();
      c.header('Cache-Control', 'private, no-store');
      return ok(c, rows.map((r) => ({ ...r, authorUserId: undefined, submittedAt: r.submittedAt?.toISOString() ?? null })));
    }));

  routes.post('/posts', requireNetworkPlatformPermission('network:author'), async (c) => {
    const body = await parseJsonBody(c.req.raw, contentSchema);
    return run(c, async (service) => {
      const { post, revision } = await service.createDraft(c.get('userId') as string, body);
      audit(c, 'network.post_draft_created', post.id);
      return ok(c, { ...present(post), revisionId: revision.id, revisionNo: revision.revisionNo }, 201);
    });
  });

  routes.put('/posts/:handle/draft', requireNetworkPlatformPermission('network:author'), async (c) => {
    const body = await parseJsonBody(c.req.raw, contentSchema);
    return run(c, async (service) => {
      const post = await postByHandle(service, c);
      const revision = await service.saveDraft(post.id, c.get('userId') as string, body);
      audit(c, 'network.post_draft_saved', post.id, { revisionNo: revision.revisionNo });
      return ok(c, { revisionId: revision.id, revisionNo: revision.revisionNo, status: revision.status });
    });
  });

  routes.post('/posts/:handle/submit', requireNetworkPlatformPermission('network:author'), async (c) =>
    run(c, async (service) => {
      const post = await postByHandle(service, c);
      const revision = await service.submit(post.id, c.get('userId') as string);
      audit(c, 'network.revision_submitted', post.id, { revisionNo: revision.revisionNo });
      return ok(c, { revisionId: revision.id, status: revision.status });
    }));

  routes.post('/revisions/:id/approve', requireNetworkPlatformPermission('network:moderate'), async (c) =>
    run(c, async (service) => {
      const outcome = await service.approve(c.req.param('id') ?? '', c.get('userId') as string);
      audit(c, outcome.status === 'published' ? 'network.post_published' : 'network.revision_approved', c.req.param('id') ?? '');
      return ok(c, outcome.status === 'published'
        ? { status: 'published', approvals: outcome.approvals, post: present(outcome.post) }
        : { status: 'recorded', approvals: outcome.approvals, required: outcome.required });
    }));

  routes.post('/revisions/:id/reject', requireNetworkPlatformPermission('network:moderate'), async (c) => {
    const body = await parseJsonBody(c.req.raw, reasonSchema);
    return run(c, async (service) => {
      const revision = await service.reject(c.req.param('id') ?? '', c.get('userId') as string, body.reasonCode);
      audit(c, 'network.revision_rejected', revision.postId, { reasonCode: revision.reasonCode });
      return ok(c, { revisionId: revision.id, status: revision.status });
    });
  });

  routes.post('/posts/:handle/suspend', requireNetworkPlatformPermission('network:moderate'), async (c) => {
    const body = await parseJsonBody(c.req.raw, reasonSchema);
    return run(c, async (service) => {
      const post = await service.suspend((await postByHandle(service, c)).id, c.get('userId') as string, body.reasonCode);
      audit(c, 'network.post_suspended', post.id, { reasonCode: body.reasonCode });
      return ok(c, present(post));
    });
  });

  for (const [path, action, method] of [
    ['lift', 'network.post_lifted', 'lift'], ['withdraw', 'network.post_withdrawn', 'withdraw'],
    ['pin', 'network.post_pinned', 'pin'], ['unpin', 'network.post_unpinned', 'unpin'],
  ] as const) {
    routes.post(`/posts/:handle/${path}`, requireNetworkPlatformPermission('network:moderate'), async (c) =>
      run(c, async (service) => {
        const found = await postByHandle(service, c);
        const post = await service[method](found.id);
        audit(c, action, post.id);
        return ok(c, present(post));
      }));
  }

  routes.get('/drafts', requireNetworkPlatformPermission('network:moderate'), async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const params = new URL(c.req.url).searchParams;
    const values = params.getAll('cursor');
    const parts = values[0]?.split('~');
    let cursor: NetworkDraftCursor | undefined;
    if (parts) {
      const [createdAt, handle] = parts;
      if (parts.length === 2 && createdAt && handle &&
          z.iso.datetime({ precision: 3 }).safeParse(createdAt).success && NETWORK_DRAFT_HANDLE.test(handle)) {
        cursor = { createdAt, handle };
      }
    }
    if ([...params.keys()].some((name) => name !== 'cursor') || values.length > 1 || (parts && !cursor)) {
      throw new AppError('Invalid draft pagination.', 400, 'INVALID_DRAFT_PAGINATION');
    }
    const { db, release } = await open(c);
    try {
      return ok(c, await listNetworkSavedDrafts(db, c.get('userId') as string, cursor));
    } finally {
      release();
    }
  });

  routes.get('/drafts/:handle', requireNetworkPlatformPermission('network:moderate'), async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const handle = c.req.param('handle');
    if (!NETWORK_DRAFT_HANDLE.test(handle)) {
      throw new AppError('Not found.', 404, 'NETWORK_NOT_FOUND');
    }
    const { db, release } = await open(c);
    try {
      const draft = await getNetworkSavedDraft(db, c.get('userId') as string, handle);
      if (!draft) throw new AppError('Not found.', 404, 'NETWORK_NOT_FOUND');
      return ok(c, draft);
    } finally {
      release();
    }
  });

  return routes;
}

export const platformNetworkModerationRoutes = createNetworkModerationRoutes();
