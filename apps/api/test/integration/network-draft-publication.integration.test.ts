import type * as PlaywrightTest from '@playwright/test';
import type * as DbClient from '../../src/db/client';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { Hono } from 'hono';
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
  ) {
    const { chromium, expect: browserExpect } = requireWeb('@playwright/test') as BrowserModule;
    let apiServer: Server | undefined;
    let web: ChildProcess | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      apiServer = createServer(async (incoming, outgoing) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
          const bytes = Buffer.concat(chunks);
          const response = await request(
            incoming.url!,
            String(incoming.headers.authorization ?? '').replace(/^Bearer /, ''),
            incoming.method,
            bytes.length ? JSON.parse(bytes.toString()) : undefined,
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
});
