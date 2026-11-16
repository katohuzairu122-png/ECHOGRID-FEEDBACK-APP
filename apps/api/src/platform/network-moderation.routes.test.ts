import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { errorHandler } from '../lib/error-handler';

const state = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'support' | 'billing',
  authenticated: true,
  authCalls: 0,
  calls: [] as string[],
}));

vi.mock('../middleware/authenticate', () => ({
  authenticate: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    state.authCalls += 1;
    if (!state.authenticated) throw Object.assign(new Error('x'), { status: 401 });
    c.set('userId', '11111111-1111-4111-8111-111111111111');
    await next();
  },
}));
vi.mock('../middleware/require-platform-role', () => ({
  requirePlatformRole: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('platformRole', state.role);
    await next();
  },
}));
vi.mock('../network/network-post.service', () => {
  const post = { id: 'p1', handle: 'A'.repeat(22), state: 'unpublished', pinned: false, publishedAt: null, expiresAt: null, liveRevisionId: null };
  const make = (name: string, value: unknown) => async (...args: unknown[]) => { state.calls.push(`${name}:${JSON.stringify(args.slice(0, 3))}`); return value; };
  return {
    NetworkPostService: class {
      createDraft = make('createDraft', { post, revision: { id: 'r1', revisionNo: 1 } });
      saveDraft = make('saveDraft', { id: 'r2', revisionNo: 2, status: 'draft' });
      submit = make('submit', { id: 'r2', status: 'submitted', revisionNo: 2 });
      approve = make('approve', { status: 'recorded', approvals: 1, required: 2 });
      reject = make('reject', { id: 'r2', status: 'rejected', postId: 'p1', reasonCode: 'spam_or_duplicate' });
      suspend = make('suspend', post); lift = make('lift', post); withdraw = make('withdraw', post);
      pin = make('pin', post); unpin = make('unpin', post);
      queue = make('queue', []);
      findByHandle = make('findByHandle', post);
    },
  };
});

import { createNetworkModerationRoutes } from './network-moderation.routes';

const env = (flag: string | null) => ({ ...(flag !== null ? { NETWORK_FEED_ENABLED: flag } : {}) }) as Bindings;
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
function app() {
  const a = new Hono<{ Bindings: Bindings }>();
  a.onError(errorHandler);
  a.route('/m', createNetworkModerationRoutes({ open: async () => ({ db: {} as never, release: () => undefined }) }));
  return a;
}
const json = { 'content-type': 'application/json' };
const content = JSON.stringify({ body: 'Official note', contentLocale: 'en' });
const handle = 'A'.repeat(22);

const ROUTES: [string, string, string | undefined][] = [
  ['GET', '/m/queue', undefined],
  ['POST', '/m/posts', content],
  ['PUT', `/m/posts/${handle}/draft`, content],
  ['POST', `/m/posts/${handle}/submit`, undefined],
  ['POST', '/m/revisions/rev-1/approve', undefined],
  ['POST', '/m/revisions/rev-1/reject', JSON.stringify({ reasonCode: 'spam_or_duplicate' })],
  ['POST', `/m/posts/${handle}/suspend`, JSON.stringify({ reasonCode: 'spam_or_duplicate' })],
  ['POST', `/m/posts/${handle}/lift`, undefined],
  ['POST', `/m/posts/${handle}/withdraw`, undefined],
  ['POST', `/m/posts/${handle}/pin`, undefined],
  ['POST', `/m/posts/${handle}/unpin`, undefined],
];
const call = (method: string, path: string, body: string | undefined, flag: string | null = 'true') =>
  app().fetch(new Request(`https://api.test${path}`, { method, headers: json, ...(body ? { body } : {}) }), env(flag), ctx);

describe('platform network moderation routes', () => {
  beforeEach(() => { state.role = 'admin'; state.authenticated = true; state.authCalls = 0; state.calls = []; });

  it.each(ROUTES)('%s %s is a generic 404 with the flag off, before authentication or any service call', async (method, path, body) => {
    for (const flag of [null, 'false', 'TRUE', '1', 'yes', ' true']) {
      const response = await call(method, path, body, flag);
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    }
    expect(state.authCalls).toBe(0);
    expect(state.calls).toEqual([]);
  });

  it.each(ROUTES)('%s %s refuses support and billing roles', async (method, path, body) => {
    for (const role of ['support', 'billing'] as const) {
      state.role = role;
      const response = await call(method, path, body);
      expect(response.status).toBe(403);
    }
    expect(state.calls).toEqual([]);
  });

  it.each(ROUTES)('%s %s works for a platform admin when enabled', async (method, path, body) => {
    const response = await call(method, path, body);
    expect(response.status).toBeLessThan(300);
    expect(state.calls.length).toBeGreaterThan(0);
  });

  it('passes the authenticated admin as actor and never a client-supplied id', async () => {
    await call('POST', '/m/posts', JSON.stringify({ body: 'x', contentLocale: 'en' }));
    expect(state.calls[0]).toContain('11111111-1111-4111-8111-111111111111');
    for (const bad of [{ body: 'x', contentLocale: 'en', authorUserId: 'someone' }, { body: 'x', contentLocale: 'xx' }, { contentLocale: 'en' }]) {
      state.calls = [];
      expect((await call('POST', '/m/posts', JSON.stringify(bad))).status).toBe(400);
      expect(state.calls).toEqual([]);
    }
  });

  it('rejects an unknown field on reason bodies and a missing reason', async () => {
    expect((await call('POST', '/m/revisions/rev-1/reject', JSON.stringify({ reasonCode: 'spam_or_duplicate', actor: 'x' }))).status).toBe(400);
    expect((await call('POST', '/m/revisions/rev-1/reject', '{}')).status).toBe(400);
  });

  it('an unauthenticated request never reaches a service', async () => {
    state.authenticated = false;
    const response = await call('GET', '/m/queue', undefined);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(state.calls).toEqual([]);
  });
});
