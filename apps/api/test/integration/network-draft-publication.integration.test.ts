import type * as PlaywrightTest from '@playwright/test';
import type * as DbClient from '../../src/db/client';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  signAccessToken,
  signCashierAccessToken,
  signImpersonationToken,
} from '../../src/auth/jwt';
import { signCustomerAccessToken } from '../../src/customer-auth/customer-jwt';
import type { Bindings } from '../../src/config/env';

// Only the Worker connection adapter is replaced. Each request still uses
// real JWT checks, current-role queries, domain transactions, DB triggers and
// audit middleware against the disposable integration database.
vi.mock('../../src/db/client', async (original) => {
  const actual = await original<typeof DbClient>();
  return {
    ...actual,
    createDb: async () => {
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      return { db: actual.buildDb(client), close: () => client.end() };
    },
  };
});

import { authRoutes } from '../../src/auth/auth.routes';
import { communityFeedRoutes } from '../../src/community/community-feed.routes';
import { communityCustomerRoutes } from '../../src/community/community-customer.routes';
import { communityPointCustomerRoutes } from '../../src/community/community-point-customer.routes';
import { platformNetworkModerationRoutes } from '../../src/platform/network-moderation.routes';
import { auditTrail } from '../../src/middleware/audit';
import { errorHandler } from '../../src/lib/error-handler';

type LifecycleData = {
  handle: string;
  revisionId: string;
  revisionNo: number;
  body: string;
  status: string;
  entries: { postHandle: string; action: string }[];
};

const base = '/api/v1/platform/network-moderation';
const secret = 'network05-disposable-staff-secret';
const customerSecret = 'network05-disposable-customer-secret';
const browserEnabled = process.env.NETWORK_LIFECYCLE_BROWSER === 'true';
const requireWeb = createRequire(resolve('../web/package.json'));
type BrowserModule = typeof PlaywrightTest;

describe.skipIf(!process.env.DATABASE_URL)('NETWORK-05 real HTTP-to-Postgres lifecycle', () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const env = {
    JWT_ACCESS_SECRET: secret,
    CUSTOMER_JWT_SECRET: customerSecret,
    PLATFORM_IMPERSONATION_ENABLED: 'true',
    NETWORK_FEED_ENABLED: 'true',
    CUSTOMER_API_RATE_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as Bindings;
  const app = new Hono<{ Bindings: Bindings }>();
  app.onError(errorHandler);
  app.use('*', auditTrail);
  app.route(base, platformNetworkModerationRoutes);
  app.route('/api/v1/auth', authRoutes);
  app.route('/api/v1/network', communityFeedRoutes);
  app.route('/api/v1/community/me', communityCustomerRoutes);
  app.route('/api/v1/community-points/me', communityPointCustomerRoutes);
  let author: string;
  let moderatorA: string;
  let moderatorB: string;
  let customer: string;
  let business: string;
  let customerToken: string;

  async function request(
    path: string,
    token: string,
    method = 'GET',
    body?: unknown,
    flag = 'true',
  ) {
    const pending: Promise<unknown>[] = [];
    const response = await app.request(
      path,
      {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { ...env, NETWORK_FEED_ENABLED: flag },
      {
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      } as unknown as ExecutionContext,
    );
    await Promise.all(pending);
    return response;
  }

  async function action(
    actor: string,
    suffix: string,
    body?: unknown,
    method = 'POST',
    expected = 200,
  ) {
    const response = await request(
      base + suffix,
      await signAccessToken(actor, secret),
      method,
      body,
    );
    expect(response.status).toBe(expected);
    return ((await response.json()) as { data: LifecycleData }).data;
  }

  async function createDraft(body = 'Initial draft') {
    return action(author, '/posts', { body, contentLocale: 'en', linkUrl: null }, 'POST', 201);
  }

  async function prepareSubmitted(body = 'Ready for review') {
    const draft = await createDraft(body);
    await action(author, `/posts/${draft.handle}/submit`);
    return draft;
  }

  async function isVisible(handle: string) {
    const response = await request('/api/v1/network/feed?limit=50', customerToken);
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: { items: { handle: string }[] } }).data.items.some(
      (item: { handle: string }) => item.handle === handle,
    );
  }

  beforeAll(async () => {
    await client.connect();
    const user = async (role: string | null) =>
      (
        await client.query<{ id: string }>(
          "insert into users(email,password_hash,full_name,status,platform_role) values ($1,'unused','NETWORK-05 fixture','active',$2) returning id",
          [`network05-${randomUUID()}@example.test`, role],
        )
      ).rows[0]!.id;
    author = await user('admin');
    moderatorA = await user('admin');
    moderatorB = await user('admin');
    customer = (
      await client.query<{ id: string }>(
        "insert into customers(phone,phone_verified_at,status) values ($1,now(),'active') returning id",
        ['+999' + String(Date.now()).slice(-10)],
      )
    ).rows[0]!.id;
    customerToken = await signCustomerAccessToken(customer, customerSecret);
    business = (
      await client.query<{ id: string }>(
        "insert into businesses(name,slug) values ('NETWORK-05 fixture',$1) returning id",
        ['network05-' + randomUUID()],
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await client.end();
  });

  it('retrieves, edits, submits and publishes only after two independent approvals, with matching audit history', async () => {
    const draft = await createDraft();
    await action(
      author,
      `/posts/${draft.handle}/draft`,
      { body: 'Saved draft', contentLocale: 'en' },
      'PUT',
    );
    const loaded = await action(author, `/drafts/${draft.handle}`, undefined, 'GET');
    expect(loaded.body).toBe('Saved draft');
    const saved = await action(
      author,
      `/posts/${draft.handle}/draft`,
      { ...loaded, handle: undefined, body: 'Edited after retrieval' },
      'PUT',
    );
    expect(saved.revisionId).toBe(draft.revisionId); // Open drafts are edited in place.
    expect(saved.revisionNo).toBe(1);
    expect(await isVisible(draft.handle)).toBe(false);
    await action(author, `/posts/${draft.handle}/submit`);
    expect(
      (await request(base + `/drafts/${draft.handle}`, await signAccessToken(author, secret)))
        .status,
    ).toBe(404);
    const first = await action(moderatorA, `/revisions/${draft.revisionId}/approve`);
    expect(first).toEqual({ status: 'recorded', approvals: 1, required: 2 });
    expect(await isVisible(draft.handle)).toBe(false);
    const second = await action(moderatorB, `/revisions/${draft.revisionId}/approve`);
    expect(second.status).toBe('published');
    expect(await isVisible(draft.handle)).toBe(true);
    const history = await action(author, '/history', undefined, 'GET');
    const entries = history.entries.filter(
      (entry: { postHandle: string }) => entry.postHandle === draft.handle,
    );
    expect(entries.map((entry: { action: string }) => entry.action).reverse()).toEqual([
      'network.post_draft_created',
      'network.post_draft_saved',
      'network.post_draft_saved',
      'network.revision_submitted',
      'network.revision_approved',
      'network.post_published',
    ]);
    expect(
      entries.every(
        (entry: object) =>
          Object.keys(entry).sort().join(',') === 'action,actorUserId,occurredAt,postHandle,status',
      ),
    ).toBe(true);
    const ownership = await client.query(
      'select author_user_id from network_posts where handle=$1',
      [draft.handle],
    );
    expect(ownership.rows[0].author_user_id).toBe(author);
    const replacement = await action(
      author,
      `/posts/${draft.handle}/draft`,
      { body: 'Replacement draft', contentLocale: 'en' },
      'PUT',
    );
    expect(replacement.revisionNo).toBe(2);
    expect(replacement.revisionId).not.toBe(draft.revisionId);
    expect(await isVisible(draft.handle)).toBe(true);
  });

  it('refuses self approval and concurrent duplicate approvals, then publishes exactly once for distinct approvers', async () => {
    const draft = await prepareSubmitted();
    const authorToken = await signAccessToken(author, secret);
    expect(
      (await request(base + `/revisions/${draft.revisionId}/approve`, authorToken, 'POST')).status,
    ).toBe(403);
    const tokenA = await signAccessToken(moderatorA, secret);
    const duplicates = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(base + `/revisions/${draft.revisionId}/approve`, tokenA, 'POST'),
      ),
    );
    expect(duplicates.map((response) => response.status).sort()).toEqual([200, 409, 409]);
    expect(await isVisible(draft.handle)).toBe(false);
    expect(
      (
        await client.query(
          'select count(*)::int n from network_revision_approvals where revision_id=$1',
          [draft.revisionId],
        )
      ).rows[0].n,
    ).toBe(1);
    const tokenB = await signAccessToken(moderatorB, secret);
    const finals = await Promise.all(
      Array.from({ length: 2 }, () =>
        request(base + `/revisions/${draft.revisionId}/approve`, tokenB, 'POST'),
      ),
    );
    expect(finals.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await isVisible(draft.handle)).toBe(true);
    const approvals = (
      await client.query(
        'select approver_user_id from network_revision_approvals where revision_id=$1 order by approver_user_id',
        [draft.revisionId],
      )
    ).rows;
    expect(approvals.map((row) => row.approver_user_id).sort()).toEqual(
      [moderatorA, moderatorB].sort(),
    );
    await expect(
      client.query(
        'update network_revision_approvals set approver_user_id=$2 where revision_id=$1',
        [draft.revisionId, author],
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects stale approvals after rejection or withdrawal and protects original-author reads and edits', async () => {
    for (const disposition of ['reject', 'withdraw']) {
      const draft = await prepareSubmitted();
      await action(moderatorA, `/revisions/${draft.revisionId}/approve`);
      if (disposition === 'reject') {
        await action(moderatorB, `/revisions/${draft.revisionId}/reject`, {
          reasonCode: 'spam_or_duplicate',
        });
      } else {
        await action(author, `/posts/${draft.handle}/withdraw`);
      }
      const response = await request(
        base + `/revisions/${draft.revisionId}/approve`,
        await signAccessToken(moderatorB, secret),
        'POST',
      );
      expect(response.status).toBe(409);
      expect(await isVisible(draft.handle)).toBe(false);
    }
    const draft = await createDraft();
    const other = await signAccessToken(moderatorA, secret);
    expect((await request(base + `/drafts/${draft.handle}`, other)).status).toBe(404);
    expect(
      (
        await request(base + `/posts/${draft.handle}/draft`, other, 'PUT', {
          body: 'Take over',
          contentLocale: 'en',
        })
      ).status,
    ).toBe(404);
    const before = await action(author, `/drafts/${draft.handle}`, undefined, 'GET');
    await action(
      author,
      `/posts/${draft.handle}/draft`,
      { body: 'Latest text', contentLocale: 'en' },
      'PUT',
    );
    await action(author, `/posts/${draft.handle}/submit`);
    const revision = (
      await client.query('select body,status from network_post_revisions where id=$1', [
        draft.revisionId,
      ])
    ).rows[0];
    expect(before.body).not.toBe(revision.body);
    expect(revision).toEqual({ body: 'Latest text', status: 'submitted' });
  });

  it('revalidates current authority and rejects cashier, customer, business and impersonated sessions on approval and history', async () => {
    const draft = await prepareSubmitted();
    const token = await signAccessToken(moderatorA, secret);
    const paths = [`/revisions/${draft.revisionId}/approve`, '/history'];
    for (const role of [null, 'support', 'billing']) {
      await client.query('update users set platform_role=$2 where id=$1', [moderatorA, role]);
      for (const path of paths) {
        expect(
          (await request(base + path, token, path === '/history' ? 'GET' : 'POST')).status,
        ).toBe(403);
      }
    }
    for (const roleName of ['Owner', 'Manager']) {
      const roleId = (
        await client.query<{ id: string }>(
          'insert into roles(business_id,name) values ($1,$2) returning id',
          [business, roleName],
        )
      ).rows[0]!.id;
      await client.query(
        'insert into user_business_roles(user_id,business_id,role_id) values ($1,$2,$3)',
        [moderatorA, business, roleId],
      );
      await client.query('update users set platform_role=null where id=$1', [moderatorA]);
      for (const path of paths) {
        expect(
          (await request(base + path, token, path === '/history' ? 'GET' : 'POST')).status,
        ).toBe(403);
      }
    }
    await client.query("update users set platform_role='admin' where id=$1", [moderatorA]);
    const impersonated = await signImpersonationToken(moderatorA, author, secret);
    const cashier = await signCashierAccessToken(moderatorA, secret, {
      businessId: business,
      sessionId: randomUUID(),
    });
    for (const [credential, status] of [
      [impersonated.token, 403],
      [cashier, 403],
      [customerToken, 401],
    ] as const) {
      for (const path of paths) {
        expect(
          (await request(base + path, credential, path === '/history' ? 'GET' : 'POST')).status,
        ).toBe(status);
      }
    }
    expect((await request('/api/v1/network/feed', token)).status).toBe(401);
    expect(
      (await request('/api/v1/network/feed', customerToken, 'GET', undefined, 'false')).status,
    ).toBe(404);
    expect((await request(base + '/queue', token, 'GET', undefined, 'false')).status).toBe(404);
  });

  async function withModerationBrowser(
    moderator: string,
    run: (
      page: PlaywrightTest.Page,
      context: PlaywrightTest.BrowserContext,
      webUrl: string,
      browserExpect: typeof PlaywrightTest.expect,
    ) => Promise<void>,
    options: { feedFlag?: () => string; failRead?: (path: string, method: string) => boolean } = {},
  ) {
    const { chromium, expect: browserExpect } = requireWeb('@playwright/test') as BrowserModule;
    let apiServer: Server | undefined;
    let web: ChildProcess | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      apiServer = createServer(async (incoming, outgoing) => {
        try {
          // Synthetic upstream read outages only; real authorization runs again on retry.
          const failRead = options.failRead?.(incoming.url!, incoming.method ?? 'GET');
          if (incoming.method === 'GET' && failRead) {
            outgoing.writeHead(503, { 'content-type': 'application/json' });
            outgoing.end(
              JSON.stringify({
                success: false,
                error: {
                  code: 'SYNTHETIC_UNAVAILABLE',
                  message: 'private synthetic upstream detail',
                },
              }),
            );
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
          const bytes = Buffer.concat(chunks);
          const response = await request(
            incoming.url!,
            String(incoming.headers.authorization ?? '').replace(/^Bearer /, ''),
            incoming.method,
            bytes.length ? JSON.parse(bytes.toString()) : undefined,
            options.feedFlag?.() ?? 'true',
          );
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(await response.text());
        } catch {
          outgoing.writeHead(500).end();
        }
      }).listen(0, '127.0.0.1');
      await once(apiServer, 'listening');
      const address = apiServer.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback API port');
      const apiUrl = `http://127.0.0.1:${address.port}`;
      const portProbe = createServer().listen(0, '127.0.0.1');
      await once(portProbe, 'listening');
      const webAddress = portProbe.address();
      if (!webAddress || typeof webAddress === 'string') throw new Error('Missing web port');
      await new Promise<void>((done) => portProbe.close(() => done()));
      const webUrl = `http://127.0.0.1:${webAddress.port}`;
      web = spawn(
        process.execPath,
        [
          requireWeb.resolve('next/dist/bin/next'),
          'start',
          '--hostname',
          '127.0.0.1',
          '--port',
          String(webAddress.port),
        ],
        {
          cwd: resolve('../web'),
          env: { ...process.env, API_BASE_URL: apiUrl },
          stdio: 'ignore',
        },
      );
      await vi.waitFor(
        async () => {
          expect((await fetch(webUrl + '/login')).ok).toBe(true);
        },
        { timeout: 30000, interval: 300 },
      );
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const token = await signAccessToken(moderator, secret);
      await context.addCookies([
        { name: 'ff_access_token', value: token, url: webUrl, httpOnly: true },
        {
          name: 'ff_refresh_token',
          value: 'synthetic-presence-only',
          url: webUrl,
          httpOnly: true,
        },
      ]);
      const page = await context.newPage();
      await run(page, context, webUrl, browserExpect);
      await context.close();
    } finally {
      await browser?.close();
      if (web && web.exitCode === null) {
        const stopped = once(web, 'exit');
        web.kill('SIGTERM');
        await stopped;
      }
      if (apiServer) await new Promise<void>((done) => apiServer!.close(() => done()));
    }
  }

  it.skipIf(!browserEnabled)(
    'browser resumes the stored draft and completes publication through real Server Actions',
    async () =>
      withModerationBrowser(author, async (page, context, webUrl, browserExpect) => {
        const draft = await createDraft('Browser initial text');
        await page.goto(webUrl + '/platform/network-moderation/drafts?draft=' + draft.handle);
        await browserExpect(page.getByLabel('Post text')).toHaveValue('Browser initial text');
        await page.getByLabel('Post text').fill('Browser edited text');
        await page.getByRole('button', { name: 'Save draft revision', exact: true }).click();
        await browserExpect(page.getByRole('status')).toContainText('Draft saved.');
        await page.getByRole('button', { name: 'Submit for approval', exact: true }).click();
        await browserExpect(page).toHaveURL(webUrl + '/platform/network-moderation');
        await browserExpect(
          page.getByRole('article').filter({ hasText: draft.handle }),
        ).toContainText('Browser edited text');
        for (const [moderator, result] of [
          [moderatorA, 'Approval recorded (1 of 2).'],
          [moderatorB, 'Revision published.'],
        ] as const) {
          await context.addCookies([
            {
              name: 'ff_access_token',
              value: await signAccessToken(moderator, secret),
              url: webUrl,
              httpOnly: true,
            },
          ]);
          await page.goto(webUrl + '/platform/network-moderation');
          const card = page.getByRole('article').filter({ hasText: draft.handle });
          await card.getByRole('button', { name: 'Approve revision', exact: true }).click();
          if (moderator === moderatorA) {
            await browserExpect(card.getByRole('status')).toContainText(result);
            expect(await isVisible(draft.handle)).toBe(false);
          } else {
            await vi.waitFor(async () => {
              expect(await isVisible(draft.handle)).toBe(true);
            });
            await browserExpect(card).toHaveCount(0);
          }
        }
        await page.goto(webUrl + '/platform/network-moderation/history');
        await browserExpect(
          page
            .getByRole('row')
            .filter({ hasText: draft.handle })
            .filter({ hasText: 'Post published' }),
        ).toBeVisible();
      }),
    120000,
  );

  it.skipIf(!browserEnabled)(
    'browser rejects a pending revision and preserves the rejection against stale approval (NETWORK-06)',
    async () =>
      withModerationBrowser(moderatorB, async (page, _context, webUrl, browserExpect) => {
        const draft = await prepareSubmitted('NETWORK-06 reject this revision');
        await action(moderatorA, `/revisions/${draft.revisionId}/approve`);
        await page.goto(webUrl + '/platform/network-moderation');
        const card = page.getByRole('article').filter({ hasText: draft.handle });
        await browserExpect(card).toContainText('1 of 2 approvals');
        await card.getByLabel('Moderation reason').selectOption('spam_or_duplicate');
        await card.getByRole('button', { name: 'Reject revision', exact: true }).click();
        await browserExpect(card).toHaveCount(0);
        expect(await isVisible(draft.handle)).toBe(false);

        const stale = await request(
          base + `/revisions/${draft.revisionId}/approve`,
          await signAccessToken(moderatorA, secret),
          'POST',
        );
        expect(stale.status).toBe(409);
        const row = (
          await client.query(
            'select status,decided_by,reason_code from network_post_revisions where id=$1',
            [draft.revisionId],
          )
        ).rows[0];
        expect(row).toEqual({
          status: 'rejected',
          decided_by: moderatorB,
          reason_code: 'spam_or_duplicate',
        });
        const approvals = (
          await client.query(
            'select count(*)::int n from network_revision_approvals where revision_id=$1',
            [draft.revisionId],
          )
        ).rows[0];
        expect(approvals.n).toBe(1);

        await page.goto(webUrl + '/platform/network-moderation/history');
        await browserExpect(
          page
            .getByRole('row')
            .filter({ hasText: draft.handle })
            .filter({ hasText: 'Revision rejected' }),
        ).toBeVisible();
        const evidence = (
          await client.query(
            `select actor_user_id,metadata->>'reasonCode' reason from audit_log
         where entity_id=(select id from network_posts where handle=$1)
         and action='network.revision_rejected'`,
            [draft.handle],
          )
        ).rows;
        expect(evidence).toEqual([{ actor_user_id: moderatorB, reason: 'spam_or_duplicate' }]);
      }),
    120000,
  );

  it.skipIf(!browserEnabled)(
    'browser withdraws published and pending posts and rejects stale approvals (NETWORK-06)',
    async () =>
      withModerationBrowser(moderatorB, async (page, _context, webUrl, browserExpect) => {
        for (const publish of [true, false]) {
          const draft = await prepareSubmitted('NETWORK-06 withdrawal');
          await action(moderatorA, `/revisions/${draft.revisionId}/approve`);
          if (publish) await action(moderatorB, `/revisions/${draft.revisionId}/approve`);
          expect(await isVisible(draft.handle)).toBe(publish);

          await page.goto(webUrl + '/platform/network-moderation');
          await page.getByLabel('Post handle', { exact: true }).fill(draft.handle);
          await page.getByLabel('Action', { exact: true }).selectOption('withdraw');
          await page.getByLabel('Apply this action to the specified post').check();
          await page.getByRole('button', { name: 'Apply action', exact: true }).click();
          await browserExpect(page.getByRole('status')).toContainText('withdrawn');
          expect(await isVisible(draft.handle)).toBe(false);
          const stale = await request(
            base + `/revisions/${draft.revisionId}/approve`,
            await signAccessToken(moderatorB, secret),
            'POST',
          );
          expect(stale.status).toBe(409);
          expect(
            (await client.query('select state from network_posts where handle=$1', [draft.handle]))
              .rows[0].state,
          ).toBe('withdrawn');
          await page.goto(webUrl + '/platform/network-moderation/history');
          await browserExpect(
            page
              .getByRole('row')
              .filter({ hasText: draft.handle })
              .filter({ hasText: 'Post withdrawn' }),
          ).toBeVisible();
        }
      }),
    120000,
  );

  it.skipIf(!browserEnabled)(
    'browser suspends and lifts a published post, preserving Feed and audit visibility (NETWORK-06)',
    async () =>
      withModerationBrowser(moderatorB, async (page, _context, webUrl, browserExpect) => {
        const manage = page.getByRole('region', { name: 'Moderate by post handle' });
        const draft = await prepareSubmitted('NETWORK-06 suspension');
        await action(moderatorA, `/revisions/${draft.revisionId}/approve`);
        await action(moderatorB, `/revisions/${draft.revisionId}/approve`);
        expect(await isVisible(draft.handle)).toBe(true);

        await page.goto(webUrl + '/platform/network-moderation');
        await manage.getByLabel('Post handle', { exact: true }).fill(draft.handle);
        await manage.getByLabel('Action', { exact: true }).selectOption('suspend');
        await manage.getByLabel('Moderation reason', { exact: true }).selectOption('unsafe_link');
        await manage.getByLabel('Apply this action to the specified post').check();
        await manage.getByRole('button', { name: 'Apply action', exact: true }).click();
        await browserExpect(manage.getByRole('status')).toContainText('suspended');
        expect(await isVisible(draft.handle)).toBe(false);

        await manage.getByLabel('Post handle', { exact: true }).fill(draft.handle);
        await manage.getByLabel('Action', { exact: true }).selectOption('lift');
        await manage.getByLabel('Apply this action to the specified post').check();
        await manage.getByRole('button', { name: 'Apply action', exact: true }).click();
        await browserExpect(manage.getByRole('status')).toContainText('published');
        expect(await isVisible(draft.handle)).toBe(true);
        await page.goto(webUrl + '/platform/network-moderation/history');
        for (const label of ['Post suspended', 'Suspension lifted']) {
          await browserExpect(
            page.getByRole('row').filter({ hasText: draft.handle }).filter({ hasText: label }),
          ).toBeVisible();
        }

        const invalid = await createDraft('NETWORK-06 cannot suspend an unpublished draft');
        await page.goto(webUrl + '/platform/network-moderation');
        await manage.getByLabel('Post handle', { exact: true }).fill(invalid.handle);
        await manage.getByLabel('Moderation reason', { exact: true }).selectOption('unsafe_link');
        await manage.getByLabel('Apply this action to the specified post').check();
        await manage.getByRole('button', { name: 'Apply action', exact: true }).click();
        await browserExpect(manage.getByRole('alert')).toContainText(
          'conflicts with its current state',
        );
        expect(await isVisible(invalid.handle)).toBe(false);
        expect(
          (
            await client.query(
              `select count(*)::int n from audit_log where action='network.post_suspended'
         and entity_id=(select id from network_posts where handle=$1)`,
              [invalid.handle],
            )
          ).rows[0].n,
        ).toBe(0);
      }),
    120000,
  );
  it.skipIf(!browserEnabled)(
    'browser refreshes the customer Feed after publication and withdrawal (NETWORK-07)',
    async () =>
      withModerationBrowser(moderatorB, async (page, context, webUrl, browserExpect) => {
        await context.addCookies([
          { name: 'ff_customer_token', value: customerToken, url: webUrl, httpOnly: true },
        ]);
        const body = 'NETWORK-07 refresh after moderation';
        const draft = await prepareSubmitted(body);
        await page.goto(webUrl + '/loyalty/dashboard/community/feed');
        await browserExpect(page.getByText(body, { exact: true })).toHaveCount(0);
        await action(moderatorA, `/revisions/${draft.revisionId}/approve`);
        await action(moderatorB, `/revisions/${draft.revisionId}/approve`);
        await page.getByRole('button', { name: 'Refresh feed', exact: true }).click();
        await browserExpect(page.getByText(body, { exact: true })).toBeVisible();
        await action(moderatorB, `/posts/${draft.handle}/withdraw`);
        await page.getByRole('button', { name: 'Refresh feed', exact: true }).click();
        await browserExpect(page.getByText(body, { exact: true })).toHaveCount(0);
        await browserExpect(
          page.getByRole('navigation', { name: 'Community sections' }),
        ).toBeVisible();
      }),
    120000,
  );

  it.skipIf(!browserEnabled)(
    'browser pages through published customer updates and returns to latest (NETWORK-07)',
    async () =>
      withModerationBrowser(moderatorB, async (page, context, webUrl, browserExpect) => {
        await context.addCookies([
          { name: 'ff_customer_token', value: customerToken, url: webUrl, httpOnly: true },
        ]);
        const prefix = 'NETWORK-07 pagination';
        for (let index = 0; index < 21; index++) {
          const draft = await prepareSubmitted(`${prefix} ${index}`);
          await action(moderatorA, `/revisions/${draft.revisionId}/approve`);
          await action(moderatorB, `/revisions/${draft.revisionId}/approve`);
        }
        await page.goto(webUrl + '/loyalty/dashboard/community/feed');
        await browserExpect(page.getByText(`${prefix} 20`, { exact: true })).toBeVisible();
        await browserExpect(page.getByText(`${prefix} 0`, { exact: true })).toHaveCount(0);
        await page.getByRole('link', { name: 'Load more', exact: true }).click();
        await browserExpect(page).toHaveURL(/cursor=/);
        await browserExpect(page.getByText(`${prefix} 0`, { exact: true })).toBeVisible();
        await page.getByRole('link', { name: 'Latest updates', exact: true }).click();
        await browserExpect(page).toHaveURL(webUrl + '/loyalty/dashboard/community/feed');
        await browserExpect(page.getByText(`${prefix} 20`, { exact: true })).toBeVisible();
      }),
    120000,
  );

  it.skipIf(!browserEnabled)(
    'browser denies missing, expired and noncustomer credentials without leaking Feed content (NETWORK-08)',
    async () =>
      withModerationBrowser(moderatorB, async (page, context, webUrl, browserExpect) => {
        const body = 'NETWORK-08 authorized customer content';
        const draft = await prepareSubmitted(body);
        await action(moderatorA, `/revisions/${draft.revisionId}/approve`);
        await action(moderatorB, `/revisions/${draft.revisionId}/approve`);
        expect(await isVisible(draft.handle)).toBe(true);

        // The helper installs valid staff cookies. Their presence grants no customer access.
        await page.goto(webUrl + '/loyalty/dashboard/community/feed');
        await browserExpect(page).toHaveURL(/\/loyalty\/login(?:\?|$)/);
        await browserExpect(page.getByText(body, { exact: true })).toHaveCount(0);
        const expired = await sign(
          { sub: customer, type: 'customer_access', iat: 1, exp: 2 },
          customerSecret,
          'HS256',
        );
        const impersonated = await signImpersonationToken(moderatorA, author, secret);
        const cashier = await signCashierAccessToken(moderatorA, secret, {
          businessId: business,
          sessionId: randomUUID(),
        });
        for (const token of [
          'malformed-credential',
          expired,
          await signAccessToken(moderatorA, secret),
          cashier,
          impersonated.token,
        ]) {
          const denied = await request('/api/v1/network/feed', token);
          expect(denied.status).toBe(401);
          expect(await denied.text()).not.toContain(body);
          await context.addCookies([
            { name: 'ff_customer_token', value: token, url: webUrl, httpOnly: true },
          ]);
          await page.goto(webUrl + '/loyalty/dashboard/community/feed');
          await browserExpect(page).toHaveURL(/\/loyalty\/login(?:\?|$)/);
          await browserExpect(page.getByText(body, { exact: true })).toHaveCount(0);
        }
        await context.addCookies([
          { name: 'ff_customer_token', value: customerToken, url: webUrl, httpOnly: true },
        ]);
        await page.goto(webUrl + '/loyalty/dashboard/community/feed');
        await browserExpect(page.getByText(body, { exact: true })).toBeVisible();
      }),
    120000,
  );

  it.skipIf(!browserEnabled)(
    'browser revalidates phone verification and active customer status on Feed refresh (NETWORK-08)',
    async () =>
      withModerationBrowser(moderatorB, async (page, context, webUrl, browserExpect) => {
        const original = (
          await client.query('select status,phone_verified_at from customers where id=$1', [
            customer,
          ])
        ).rows[0];
        const body = 'NETWORK-08 eligibility revalidation';
        const draft = await prepareSubmitted(body);
        await action(moderatorA, `/revisions/${draft.revisionId}/approve`);
        await action(moderatorB, `/revisions/${draft.revisionId}/approve`);
        await context.addCookies([
          { name: 'ff_customer_token', value: customerToken, url: webUrl, httpOnly: true },
        ]);
        try {
          await page.goto(webUrl + '/loyalty/dashboard/community/feed');
          await browserExpect(page.getByText(body, { exact: true })).toBeVisible();
          await client.query('update customers set phone_verified_at=null where id=$1', [customer]);
          const denied = await request('/api/v1/network/feed', customerToken);
          expect(denied.status).toBe(403);
          expect(await denied.text()).not.toContain(body);
          await page.getByRole('button', { name: 'Refresh feed', exact: true }).click();
          await browserExpect(page.getByRole('status')).toContainText(
            'not available with your current access',
          );
          await browserExpect(page.getByText(body, { exact: true })).toHaveCount(0);
          await browserExpect(
            page.getByRole('button', { name: 'Refresh feed', exact: true }),
          ).toHaveCount(0);
          await client.query('update customers set phone_verified_at=$2 where id=$1', [
            customer,
            original.phone_verified_at,
          ]);
          await page.reload();
          await browserExpect(page.getByText(body, { exact: true })).toBeVisible();
          await client.query("update customers set status='suspended' where id=$1", [customer]);
          expect((await request('/api/v1/network/feed', customerToken)).status).toBe(401);
          await page.getByRole('button', { name: 'Refresh feed', exact: true }).click();
          await browserExpect(page).toHaveURL(/\/loyalty\/login(?:\?|$)/);
          await browserExpect(page.getByText(body, { exact: true })).toHaveCount(0);
        } finally {
          await client.query('update customers set status=$2,phone_verified_at=$3 where id=$1', [
            customer,
            original.status,
            original.phone_verified_at,
          ]);
        }
      }),
    120000,
  );

  it.skipIf(!browserEnabled)(
    'browser fails closed on Feed flags while preserving read-only Points and Membership (NETWORK-08)',
    async () => {
      let flag = 'true';
      await withModerationBrowser(
        moderatorB,
        async (page, context, webUrl, browserExpect) => {
          await context.addCookies([
            { name: 'ff_customer_token', value: customerToken, url: webUrl, httpOnly: true },
          ]);
          const snapshot = async () =>
            (
              await client.query(
                `select
          (select count(*)::int from community_memberships where customer_id=$1) memberships,
          (select count(*)::int from community_point_accounts where customer_id=$1) accounts,
          (select count(*)::int from community_point_transactions where customer_id=$1) transactions`,
                [customer],
              )
            ).rows[0];
          const before = await snapshot();
          const allowed = await request('/api/v1/network/feed', customerToken);
          expect(allowed.headers.get('cache-control')).toBe('private, no-store');
          await page.goto(webUrl + '/loyalty/dashboard/community/feed');
          await browserExpect(
            page.getByRole('heading', { name: 'Community feed', exact: true }),
          ).toBeVisible();
          await browserExpect(
            page.getByRole('navigation', { name: 'Community sections' }),
          ).toBeVisible();
          for (const disabled of ['false', 'TRUE', '']) {
            flag = disabled;
            const status = await request(
              '/api/v1/network/status',
              customerToken,
              'GET',
              undefined,
              flag,
            );
            expect(status.status).toBe(200);
            expect(status.headers.get('cache-control')).toBe('private, no-store');
            expect(((await status.json()) as { data: { enabled: boolean } }).data.enabled).toBe(
              false,
            );
            const denied = await request(
              '/api/v1/network/feed',
              customerToken,
              'GET',
              undefined,
              flag,
            );
            expect(denied.status).toBe(404);
            await page.goto(webUrl + '/loyalty/dashboard/community/feed');
            await browserExpect(
              page.getByRole('heading', { name: 'Community feed', exact: true }),
            ).toHaveCount(0);
            await browserExpect(
              page.getByRole('button', { name: 'Refresh feed', exact: true }),
            ).toHaveCount(0);
            await page.goto(webUrl + '/loyalty/dashboard/community');
            await browserExpect(
              page.getByRole('heading', { name: 'Community hub', exact: true }),
            ).toBeVisible();
            await browserExpect(
              page.getByRole('heading', { name: 'Community Points', exact: true }),
            ).toBeVisible();
            await browserExpect(page.getByTestId('membership-status')).toHaveText('Not a member');
            await browserExpect(
              page.getByRole('navigation', { name: 'Community sections' }),
            ).toHaveCount(0);
            await browserExpect(
              page.getByRole('link', { name: 'Community', exact: true }),
            ).toHaveCount(1);
            expect((await request('/api/v1/community/me', customerToken)).status).toBe(200);
            expect(
              (await request('/api/v1/community-points/me/transactions', customerToken)).status,
            ).toBe(200);
          }
          expect(await snapshot()).toEqual(before);
        },
        { feedFlag: () => flag },
      );
    },
    120000,
  );

  it.skipIf(!browserEnabled)(
    'browser retries moderation history at the same cursor and rechecks revoked authority (NETWORK-09)',
    async () => {
      const older = await createDraft('NETWORK-09 older history evidence');
      const boundary = await createDraft('NETWORK-09 history cursor boundary');
      const cursor = (
        await client.query(
          `select id from audit_log where action='network.post_draft_created'
        and entity_id=(select id from network_posts where handle=$1)`,
          [boundary.handle],
        )
      ).rows[0].id as string;
      let outage = true;
      const methods: string[] = [];
      await withModerationBrowser(
        moderatorB,
        async (page, _context, webUrl, browserExpect) => {
          const target =
            webUrl + '/platform/network-moderation/history?' + new URLSearchParams({ cursor });
          await page.goto(target);
          await browserExpect(
            page
              .getByRole('alert')
              .filter({ hasText: /could not be loaded|saved draft is unavailable/ }),
          ).toContainText('Moderation history could not be loaded');
          await browserExpect(page.getByText('private synthetic upstream detail')).toHaveCount(0);
          outage = false;
          await page.getByRole('button', { name: 'Retry loading', exact: true }).click();
          await browserExpect(page.getByRole('table')).toBeVisible();
          await browserExpect(page).toHaveURL(target);
          await browserExpect(
            page.getByRole('row').filter({ hasText: older.handle }),
          ).toBeVisible();
          expect(methods.every((method) => method === 'GET')).toBe(true);

          outage = true;
          await page.reload();
          await browserExpect(
            page.getByRole('button', { name: 'Retry loading', exact: true }),
          ).toBeVisible();
          await client.query("update users set platform_role='support' where id=$1", [moderatorB]);
          try {
            outage = false;
            await page.getByRole('button', { name: 'Retry loading', exact: true }).click();
            await browserExpect(
              page.getByRole('heading', { name: 'Moderation history', exact: true }),
            ).toHaveCount(0);
            await browserExpect(page.getByRole('table')).toHaveCount(0);
            await browserExpect(
              page.getByRole('button', { name: 'Retry loading', exact: true }),
            ).toHaveCount(0);
          } finally {
            await client.query("update users set platform_role='admin' where id=$1", [moderatorB]);
          }
        },
        {
          failRead: (path, method) => {
            methods.push(method);
            return outage && path.startsWith('/api/v1/platform/network-moderation/history');
          },
        },
      );
    },
    120000,
  );

  it.skipIf(!browserEnabled)(
    'browser retries saved draft list and selection without losing cursor or mutating the draft (NETWORK-09)',
    async () => {
      const draft = await createDraft('NETWORK-09 retained saved draft');
      const newer = await createDraft('NETWORK-09 saved draft cursor boundary');
      const createdAt = (
        await client.query('select created_at from network_post_revisions where id=$1', [
          newer.revisionId,
        ])
      ).rows[0].created_at as Date;
      const cursor = `${createdAt.toISOString()}~${newer.handle}`;
      const query = new URLSearchParams({ cursor, draft: draft.handle });
      const snapshot = async () =>
        (
          await client.query(
            `select p.author_user_id,p.state,r.body,r.status,r.revision_no,
        (select count(*)::int from audit_log where entity_id=p.id) audit_count
        from network_posts p join network_post_revisions r on r.post_id=p.id where p.handle=$1`,
            [draft.handle],
          )
        ).rows;
      const before = await snapshot();
      let failedPath: string | null = '/api/v1/platform/network-moderation/drafts';
      const methods: string[] = [];
      await withModerationBrowser(
        author,
        async (page, _context, webUrl, browserExpect) => {
          const target = webUrl + '/platform/network-moderation/drafts?' + query;
          await page.goto(target);
          await browserExpect(
            page
              .getByRole('alert')
              .filter({ hasText: /could not be loaded|saved draft is unavailable/ }),
          ).toContainText('Saved drafts could not be loaded');
          await browserExpect(page.getByText('private synthetic upstream detail')).toHaveCount(0);
          failedPath = null;
          await page.getByRole('button', { name: 'Retry loading', exact: true }).click();
          await browserExpect(page.getByLabel('Post text')).toHaveValue(
            'NETWORK-09 retained saved draft',
          );
          await browserExpect(page).toHaveURL(target);

          failedPath = `/api/v1/platform/network-moderation/drafts/${draft.handle}`;
          await page.reload();
          await browserExpect(
            page
              .getByRole('alert')
              .filter({ hasText: /could not be loaded|saved draft is unavailable/ }),
          ).toContainText('This saved draft is unavailable');
          await browserExpect(
            page.getByRole('link', { name: 'Open draft ' + draft.handle, exact: true }),
          ).toBeVisible();
          await browserExpect(page.getByLabel('Post text')).toHaveCount(0);
          failedPath = null;
          await page.getByRole('button', { name: 'Retry loading', exact: true }).click();
          await browserExpect(page.getByLabel('Post text')).toHaveValue(
            'NETWORK-09 retained saved draft',
          );
          await browserExpect(page).toHaveURL(target);
          expect(methods.every((method) => method === 'GET')).toBe(true);
          expect(await snapshot()).toEqual(before);
        },
        {
          failRead: (path, method) => {
            methods.push(method);
            return new URL(path, 'http://fixture.invalid').pathname === failedPath;
          },
        },
      );
    },
    120000,
  );

  it.skipIf(!browserEnabled)(
    'browser recovers a failed approval queue without mutation and preserves revoked-role and flag denials (NETWORK-10)',
    async () => {
      const body = 'NETWORK-10 queue recovery evidence';
      const draft = await prepareSubmitted(body);
      const snapshot = async () =>
        (
          await client.query(
            `select r.status,r.body,p.state,p.author_user_id,
        (select count(*)::int from network_revision_approvals where revision_id=r.id) approvals,
        (select count(*)::int from audit_log where entity_id=p.id) audit_count
        from network_post_revisions r join network_posts p on p.id=r.post_id where r.id=$1`,
            [draft.revisionId],
          )
        ).rows;
      const before = await snapshot();
      let outage = true;
      let flag = 'true';
      const methods: string[] = [];
      await withModerationBrowser(
        moderatorB,
        async (page, _context, webUrl, browserExpect) => {
          const target = webUrl + '/platform/network-moderation';
          await page.goto(target);
          await browserExpect(
            page
              .getByRole('alert')
              .filter({ hasText: 'Pending approval queue could not be loaded' }),
          ).toBeVisible();
          await browserExpect(page.getByText('private synthetic upstream detail')).toHaveCount(0);
          await browserExpect(page.getByText('No revisions are awaiting review.')).toHaveCount(0);
          await browserExpect(
            page.getByRole('button', { name: 'Approve revision', exact: true }),
          ).toHaveCount(0);
          await browserExpect(
            page.getByRole('button', { name: 'Create draft', exact: true }),
          ).toHaveCount(0);
          await page.getByRole('link', { name: 'Moderation history', exact: true }).click();
          await browserExpect(
            page.getByRole('heading', { name: 'Moderation history', exact: true }),
          ).toBeVisible();
          await page.goto(target);
          await page.getByRole('link', { name: 'Saved drafts', exact: true }).click();
          await browserExpect(
            page.getByRole('heading', { name: 'Saved drafts', exact: true }),
          ).toBeVisible();
          await page.goto(target);
          outage = false;
          await page.getByRole('button', { name: 'Retry loading', exact: true }).click();
          await browserExpect(page.getByRole('article').filter({ hasText: body })).toBeVisible();
          await browserExpect(page).toHaveURL(target);
          expect(await snapshot()).toEqual(before);
          expect(methods.every((method) => method === 'GET')).toBe(true);

          outage = true;
          await page.reload();
          await browserExpect(
            page.getByRole('button', { name: 'Retry loading', exact: true }),
          ).toBeVisible();
          await client.query("update users set platform_role='support' where id=$1", [moderatorB]);
          try {
            outage = false;
            expect(
              (await request(base + '/queue', await signAccessToken(moderatorB, secret))).status,
            ).toBe(403);
            await page.getByRole('button', { name: 'Retry loading', exact: true }).click();
            await browserExpect(
              page.getByRole('heading', { name: 'Community moderation', exact: true }),
            ).toHaveCount(0);
            await browserExpect(page.getByText(body, { exact: true })).toHaveCount(0);
            await browserExpect(
              page.getByRole('button', { name: 'Retry loading', exact: true }),
            ).toHaveCount(0);
          } finally {
            await client.query("update users set platform_role='admin' where id=$1", [moderatorB]);
          }
          flag = 'false';
          expect(
            (
              await request(
                base + '/queue',
                await signAccessToken(moderatorB, secret),
                'GET',
                undefined,
                flag,
              )
            ).status,
          ).toBe(404);
          await page.goto(target);
          await browserExpect(
            page.getByRole('heading', { name: 'Community moderation', exact: true }),
          ).toHaveCount(0);
          await browserExpect(
            page.getByRole('button', { name: 'Retry loading', exact: true }),
          ).toHaveCount(0);
          expect(await snapshot()).toEqual(before);
        },
        {
          feedFlag: () => flag,
          failRead: (path, method) => {
            methods.push(method);
            return outage && new URL(path, 'http://fixture.invalid').pathname === base + '/queue';
          },
        },
      );
    },
    120000,
  );

  it.skipIf(!browserEnabled)(
    'browser pins, unpins and transfers the single official pin with customer ordering and audit evidence (NETWORK-11)',
    async () => {
      const publish = async (body: string) => {
        const draft = await prepareSubmitted(body);
        await action(moderatorA, `/revisions/${draft.revisionId}/approve`);
        await action(moderatorB, `/revisions/${draft.revisionId}/approve`);
        return draft;
      };
      const older = await publish('NETWORK-11 older official update');
      const newer = await publish('NETWORK-11 newer official update');
      const firstVisible = async () => {
        const response = await request('/api/v1/network/feed?limit=50', customerToken);
        expect(response.status).toBe(200);
        return ((await response.json()) as { data: { items: { handle: string }[] } }).data.items[0]
          ?.handle;
      };
      expect(await firstVisible()).toBe(newer.handle);
      await withModerationBrowser(moderatorB, async (page, context, webUrl, browserExpect) => {
        await context.addCookies([
          { name: 'ff_customer_token', value: customerToken, url: webUrl, httpOnly: true },
        ]);
        const manage = page.getByRole('region', { name: 'Moderate by post handle' });
        const apply = async (handle: string, operation: 'pin' | 'unpin') => {
          await page.goto(webUrl + '/platform/network-moderation');
          await manage.getByLabel('Post handle', { exact: true }).fill(handle);
          await manage.getByLabel('Action', { exact: true }).selectOption(operation);
          await manage.getByLabel('Apply this action to the specified post').check();
          await manage.getByRole('button', { name: 'Apply action', exact: true }).click();
          const status = manage.getByRole('status');
          await browserExpect(status).toContainText(handle);
          await browserExpect(status).toContainText('published');
          if (operation === 'pin') await browserExpect(status).toContainText('pinned');
          else await browserExpect(status).not.toContainText('pinned');
        };
        await apply(older.handle, 'pin');
        expect(await firstVisible()).toBe(older.handle);
        await page.goto(webUrl + '/loyalty/dashboard/community/feed');
        await browserExpect(page.getByRole('article').first()).toContainText(
          'NETWORK-11 older official update',
        );
        await apply(older.handle, 'unpin');
        expect(await firstVisible()).toBe(newer.handle);
        await page.goto(webUrl + '/loyalty/dashboard/community/feed');
        await browserExpect(page.getByRole('article').first()).toContainText(
          'NETWORK-11 newer official update',
        );
        await apply(older.handle, 'pin');
        await apply(newer.handle, 'pin');
        const pins = await client.query('select handle from network_posts where pinned');
        expect(pins.rows.map((row) => row.handle)).toEqual([newer.handle]);
        expect(await firstVisible()).toBe(newer.handle);
        await apply(newer.handle, 'unpin');
        expect(
          (await client.query('select count(*)::int n from network_posts where pinned')).rows[0].n,
        ).toBe(0);
        await page.goto(webUrl + '/platform/network-moderation/history');
        for (const [handle, pinCount] of [
          [older.handle, 2],
          [newer.handle, 1],
        ] as const) {
          await browserExpect(
            page.getByRole('row').filter({ hasText: handle }).filter({ hasText: 'Post pinned' }),
          ).toHaveCount(pinCount);
          await browserExpect(
            page.getByRole('row').filter({ hasText: handle }).filter({ hasText: 'Post unpinned' }),
          ).toHaveCount(1);
          expect(
            (
              await client.query(
                `select count(*)::int n from network_revision_approvals
            where revision_id=(select live_revision_id from network_posts where handle=$1)`,
                [handle],
              )
            ).rows[0].n,
          ).toBe(2);
        }
      });
    },
    120000,
  );

  it.skipIf(!browserEnabled)(
    'browser refuses ineligible pins and revalidates moderator authority without pin audit or publication changes (NETWORK-11)',
    async () => {
      const unpublished = await createDraft('NETWORK-11 unpublished pin refusal');
      const publish = async (body: string) => {
        const draft = await prepareSubmitted(body);
        await action(moderatorA, `/revisions/${draft.revisionId}/approve`);
        await action(moderatorB, `/revisions/${draft.revisionId}/approve`);
        return draft;
      };
      const expired = await publish('NETWORK-11 expired pin refusal');
      // Synthetic disposable fixture only, using the existing integration expiry setup.
      await client.query(
        `update network_posts set published_at=now()-interval '31 days',
        expires_at=now()-interval '1 day' where handle=$1`,
        [expired.handle],
      );
      const suspended = await publish('NETWORK-11 suspended pin refusal');
      await action(moderatorB, `/posts/${suspended.handle}/suspend`, { reasonCode: 'unsafe_link' });
      const withdrawn = await publish('NETWORK-11 withdrawn pin refusal');
      await action(moderatorB, `/posts/${withdrawn.handle}/withdraw`);
      const eligible = await publish('NETWORK-11 authority pin refusal');
      const state = async (handle: string) =>
        (
          await client.query(
            `select state,pinned,live_revision_id,expires_at
        from network_posts where handle=$1`,
            [handle],
          )
        ).rows[0];
      const pinAuditCount = async (handle: string) =>
        (
          await client.query(
            `select count(*)::int n from audit_log
        where action='network.post_pinned' and entity_id=(select id from network_posts where handle=$1)`,
            [handle],
          )
        ).rows[0].n;
      await withModerationBrowser(moderatorB, async (page, _context, webUrl, browserExpect) => {
        const manage = page.getByRole('region', { name: 'Moderate by post handle' });
        for (const draft of [unpublished, expired, suspended, withdrawn]) {
          const before = await state(draft.handle);
          const auditBefore = await pinAuditCount(draft.handle);
          await page.goto(webUrl + '/platform/network-moderation');
          await manage.getByLabel('Post handle', { exact: true }).fill(draft.handle);
          await manage.getByLabel('Action', { exact: true }).selectOption('pin');
          await manage.getByLabel('Apply this action to the specified post').check();
          await manage.getByRole('button', { name: 'Apply action', exact: true }).click();
          await browserExpect(manage.getByRole('alert')).toContainText(
            'conflicts with its current state',
          );
          expect(await state(draft.handle)).toEqual(before);
          expect(await pinAuditCount(draft.handle)).toBe(auditBefore);
          expect(await isVisible(draft.handle)).toBe(false);
        }
        await page.goto(webUrl + '/platform/network-moderation');
        await manage.getByLabel('Post handle', { exact: true }).fill(eligible.handle);
        await manage.getByLabel('Action', { exact: true }).selectOption('pin');
        await manage.getByLabel('Apply this action to the specified post').check();
        const before = await state(eligible.handle);
        const auditBefore = await pinAuditCount(eligible.handle);
        await client.query("update users set platform_role='support' where id=$1", [moderatorB]);
        try {
          await manage.getByRole('button', { name: 'Apply action', exact: true }).click();
          await browserExpect(manage.getByRole('alert')).toContainText('not authorized');
          const impersonated = await signImpersonationToken(moderatorA, author, secret);
          const cashier = await signCashierAccessToken(moderatorA, secret, {
            businessId: business,
            sessionId: randomUUID(),
          });
          for (const [token, expected] of [
            [await signAccessToken(moderatorB, secret), 403],
            [impersonated.token, 403],
            [cashier, 403],
            [customerToken, 401],
          ] as const) {
            for (const operation of ['pin', 'unpin']) {
              expect(
                (await request(`${base}/posts/${eligible.handle}/${operation}`, token, 'POST'))
                  .status,
              ).toBe(expected);
            }
          }
          expect(await state(eligible.handle)).toEqual(before);
          expect(await pinAuditCount(eligible.handle)).toBe(auditBefore);
        } finally {
          await client.query("update users set platform_role='admin' where id=$1", [moderatorB]);
        }
      });
    },
    120000,
  );
});
