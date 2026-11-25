import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { resolveTargets } from './targets';

/**
 * CASHIER-AUTH-02E E2-C: browser acceptance of the cashier and customer interfaces (02C branch context, 02D invitations).
 *
 * Opt-in (E2E_ACCEPTANCE_MODE). Every test carries a `mode` annotation, so the API harness accepts its result only as evidence of that mode:
 * a LOCAL pass is never STAGING evidence. Local runs use throw-away fixtures (see apps/api/scripts/acceptance/cashier-02/local-fixture.ts); in
 * particular local CUSTOMERS are database fixtures with a locally minted session, NOT the real sign-up and OTP flow, which needs the approved
 * test mailbox and is therefore not exercised here. Staging runs need the owner's approval in the harness configuration and supply their
 * fixture through environment variables (names below). Nothing is created that this file deletes; nothing is cleaned up.
 *
 * Titles start with a scenario id (B01..B08): the harness uses it as the check id.
 */
const mode = process.env.E2E_ACCEPTANCE_MODE;
test.skip(!mode, 'Browser acceptance is opt-in: set E2E_ACCEPTANCE_MODE=local|staging (see apps/web/e2e/acceptance).');

interface Fixture {
  businessName: string;
  branches: Array<{ id?: string; name: string }>;
  cashierCode: string;
  multi: { username: string; password: string };
  single?: { username: string; password: string };
  customers: Array<{ token: string }>;
}

function loadFixture(): Fixture | null {
  if (!mode) return null;
  if (mode === 'local') {
    const file = process.env.E2E_LOCAL_FIXTURE;
    if (!file) throw new Error('E2E_LOCAL_FIXTURE must name the local fixture file (outside the repository).');
    const f = JSON.parse(readFileSync(file, 'utf8')) as Fixture & { mode: string };
    if (f.mode !== 'local') throw new Error('the fixture file is not a local fixture');
    return f;
  }
  // staging: names only; values come from the environment and are never printed.
  const e = process.env;
  const need = ['E2E_CASHIER_CODE', 'E2E_CASHIER_USERNAME', 'E2E_CASHIER_PASSWORD', 'E2E_BRANCH_MAIN', 'E2E_BRANCH_OTHER', 'E2E_BUSINESS_NAME'];
  const missing = need.filter((n) => !e[n]);
  if (missing.length > 0) throw new Error(`Missing environment variables (names only): ${missing.join(', ')}`);
  return {
    businessName: e.E2E_BUSINESS_NAME as string,
    branches: [{ name: e.E2E_BRANCH_MAIN as string }, { name: e.E2E_BRANCH_OTHER as string }],
    cashierCode: e.E2E_CASHIER_CODE as string,
    multi: { username: e.E2E_CASHIER_USERNAME as string, password: e.E2E_CASHIER_PASSWORD as string },
    // Staging customers need a real signed-in session (the real sign-up and OTP flow, E2-A). Supplied only by an authorised operator.
    customers: [e.E2E_CUSTOMER_TOKEN_A, e.E2E_CUSTOMER_TOKEN_B].filter((t): t is string => !!t).map((token) => ({ token })),
  };
}

const targets = mode ? resolveTargets(process.env) : { mode: 'local' as const, web: 'http://localhost:3000', cashier: 'http://localhost:3000' };
const fx = loadFixture();
const messages = (locale: string, file: string) => JSON.parse(readFileSync(path.join(__dirname, `../../messages/${locale}/${file}.json`), 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const cashierEn = messages('en', 'cashier'), cashierAr = messages('ar', 'cashier');
const loyaltyEn = messages('en', 'loyalty'), loyaltyAr = messages('ar', 'loyalty');
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '');
const INVITE_LINK = /\/loyalty\/invite\/([\w.-]+)$/;
const SESSION_COOKIE = 'ff_customer_token';

test.beforeEach(() => {
  test.info().annotations.push({ type: 'mode', description: targets.mode });
});

// The strict authentication limiter allows about 10 strict calls a minute per source and a multi-branch cashier sign-in makes two (login, then session): space sign-ins out instead of hitting it.
let lastSignIn = 0;
async function pace() {
  const wait = lastSignIn + 13_000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSignIn = Date.now();
}

async function newContext(browser: Browser, locale: 'en' | 'ar', viewport = { width: 390, height: 800 }): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport });
  await context.addCookies([{ name: 'ff_locale', value: locale, url: targets.cashier }]);
  return context;
}

/** Signs a cashier in through the real cashier login. Returns the page on the serving screen for the chosen branch. */
async function cashierPage(browser: Browser, locale: 'en' | 'ar', branchName: string, viewport?: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await newContext(browser, locale, viewport);
  const page = await context.newPage();
  await pace();
  await page.goto(`${targets.cashier}/cashier/login`);
  const t = locale === 'en' ? cashierEn : cashierAr;
  await page.getByRole('button', { name: t.login.managed.useCode }).click();
  await page.getByLabel(t.login.managed.businessCode).fill(fx!.cashierCode);
  await page.getByLabel(t.login.managed.username).fill(fx!.multi.username);
  await page.getByLabel(t.login.password).fill(fx!.multi.password);
  await page.locator('button[type=submit]').click();
  await page.locator('#branchId').waitFor({ timeout: 30_000 });
  await page.locator('#branchId').selectOption({ label: branchName });
  await page.getByRole('button', { name: t.login.continue }).click();
  await page.waitForURL(/\/cashier(\/)?$/, { timeout: 30_000 });
  return { context, page };
}

async function createInvite(page: Page, locale: 'en' | 'ar'): Promise<string> {
  const t = locale === 'en' ? cashierEn : cashierAr;
  await page.goto(`${targets.cashier}/cashier/invite`);
  await page.getByRole('button', { name: t.invite.create }).click();
  await page.getByRole('img', { name: t.invite.qrLabel }).waitFor({ timeout: 25_000 });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(targets.cashier).origin });
  await page.getByRole('button', { name: t.invite.copy }).click();
  await page.waitForTimeout(400);
  return page.evaluate(() => navigator.clipboard.readText());
}

/** Horizontal overflow: the document is wider than the viewport, or an element sticks out of it. */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const wide = document.documentElement.scrollWidth - vw;
    const outside = [...document.querySelectorAll('body *')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > vw + 1 || r.left < -1);
    }).length;
    return { wide, outside };
  });
}

const customerContext = async (browser: Browser, index: number, locale: 'en' | 'ar', viewport = { width: 390, height: 800 }) => {
  const c = fx!.customers[index];
  if (!c) throw new Error('no customer session');
  const context = await browser.newContext({ viewport });
  await context.addCookies([
    { name: SESSION_COOKIE, value: c.token, url: targets.web },
    { name: 'ff_locale', value: locale, url: targets.web },
  ]);
  return context;
};
const needCustomers = (n: number) => test.skip(!fx || fx.customers.length < n, `needs ${n} signed-in customer session(s): local fixture customers, or operator-supplied sessions in staging (the real sign-up and OTP flow is E2-A and needs the approved mailbox)`);

// B04 and B05 use the link B02 creates; if B02 fails they fail too (they are not hidden by it).
let mainLink = '';
const mainBranch = fx?.branches[0]?.name ?? '';

test('B01 cashier signs in with the business code and chooses a branch; the serving screen shows it', async ({ browser }) => {
  const { context, page } = await cashierPage(browser, 'en', mainBranch);
  await expect(page.locator('body')).toContainText(mainBranch);
  // CASHIER-FINAL-RECONCILIATION: Invite Customers is not a cashier function, so there is no Invite tab.
  await expect(page.getByRole('link', { name: cashierEn.header.invite })).toHaveCount(0);
  await context.close();
});

// SUPERSEDED by CASHIER-FINAL-RECONCILIATION: depends on cashier-issued invitations, which were withdrawn; re-base on the owner-facing flow if Owner approves it.
test.fixme('B02 the Invite screen creates a one-time invitation: QR, countdown and a link carrying only the documented claims', async ({ browser }) => {
  const { context, page } = await cashierPage(browser, 'en', mainBranch);
  const link = await createInvite(page, 'en');
  expect(link).toMatch(INVITE_LINK);
  mainLink = link;
  await expect(page.getByRole('timer')).toContainText(fill(cashierEn.invite.validFor, { time: '' }).trim().split(' ')[0] as string);
  const token = INVITE_LINK.exec(link)![1] as string;
  const claims = JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString()) as Record<string, unknown>;
  expect(Object.keys(claims).sort()).toEqual(['biz', 'brid', 'exp', 'iat', 'jti', 'sid', 'sub', 'type']);
  expect(JSON.stringify(claims)).not.toMatch(/@|\+\d{7,}/);
  const branchId = fx!.branches[0]!.id;
  if (branchId) expect(claims.brid).toBe(branchId);
  await context.close();
});

// SUPERSEDED by CASHIER-FINAL-RECONCILIATION: depends on cashier-issued invitations, which were withdrawn; re-base on the owner-facing flow if Owner approves it.
test.fixme('B03 branch context: a cashier serving at another branch issues an invitation for that branch only', async ({ browser }) => {
  const other = fx!.branches[1]!;
  const { context, page } = await cashierPage(browser, 'en', other.name);
  await expect(page.locator('body')).toContainText(other.name);
  const link = await createInvite(page, 'en');
  const claims = JSON.parse(Buffer.from((INVITE_LINK.exec(link)![1] as string).split('.')[1] as string, 'base64url').toString()) as Record<string, unknown>;
  const mainId = fx!.branches[0]!.id;
  if (other.id) expect(claims.brid).toBe(other.id);
  if (other.id && mainId) expect(claims.brid).not.toBe(mainId);
  await context.close();
});

// SUPERSEDED by CASHIER-FINAL-RECONCILIATION: depends on cashier-issued invitations, which were withdrawn; re-base on the owner-facing flow if Owner approves it.
test.fixme('B04 customer join: business and branch are shown, Join stays disabled until the explicit consent, then the customer is in', async ({ browser }) => {
  needCustomers(2);
  const context = await customerContext(browser, 0, 'en');
  const page = await context.newPage();
  await page.goto(mainLink);
  const join = page.getByRole('button', { name: loyaltyEn.customer.invite.join, exact: true });
  await expect(page.locator('main')).toContainText(mainBranch);
  await expect(join).toBeDisabled();
  await page.getByRole('checkbox').check();
  await expect(join).toBeEnabled();
  await join.click();
  await expect(page.getByText(loyaltyEn.customer.invite.joinedTitle)).toBeVisible({ timeout: 30_000 });
  await context.close();
});

// SUPERSEDED by CASHIER-FINAL-RECONCILIATION: depends on cashier-issued invitations, which were withdrawn; re-base on the owner-facing flow if Owner approves it.
test.fixme('B05 membership state and single use: the same invitation shows "already used" to another customer, and a member sees "already a member"', async ({ browser }) => {
  needCustomers(2);
  const other = await (await customerContext(browser, 1, 'en')).newPage();
  await other.goto(mainLink);
  await expect(other.getByText(loyaltyEn.customer.invite.usedTitle)).toBeVisible();
  await expect(other.getByRole('button', { name: loyaltyEn.customer.invite.join, exact: true })).toHaveCount(0);
  await other.context().close();
  // a fresh invitation shown to the customer who already joined: nothing more to do
  const { context, page } = await cashierPage(browser, 'en', mainBranch);
  const freshLink = await createInvite(page, 'en');
  await context.close();
  const member = await (await customerContext(browser, 0, 'en')).newPage();
  await member.goto(freshLink);
  await expect(member.getByText(fill(loyaltyEn.customer.invite.alreadyMemberTitle, { businessName: fx!.businessName }))).toBeVisible();
  await member.context().close();
});

test('B06 rejection state: an invalid invitation is refused clearly and offers no way to join', async ({ browser }) => {
  needCustomers(1);
  const page = await (await customerContext(browser, 0, 'en')).newPage();
  await page.goto(`${targets.web}/loyalty/invite/not-a-real-invitation-token`);
  await expect(page.getByText(loyaltyEn.customer.invite.invalidTitle)).toBeVisible();
  await expect(page.getByRole('button', { name: loyaltyEn.customer.invite.join, exact: true })).toHaveCount(0);
  await page.context().close();
});

// SUPERSEDED by CASHIER-FINAL-RECONCILIATION: depends on cashier-issued invitations, which were withdrawn; re-base on the owner-facing flow if Owner approves it.
test.fixme('B07 Arabic and right-to-left: the cashier Invite screen and the customer page are translated, RTL, and fit 375 px', async ({ browser }) => {
  const { context, page } = await cashierPage(browser, 'ar', fx!.branches[0]!.name, { width: 375, height: 700 });
  await page.goto(`${targets.cashier}/cashier/invite`);
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
  expect(await page.evaluate(() => document.documentElement.lang)).toMatch(/^ar/);
  await expect(page.getByRole('heading', { name: cashierAr.invite.title })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(cashierEn.invite.title);
  expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe('rtl');
  const before = await overflow(page);
  expect(before, 'cashier invite (ar) before creating').toEqual({ wide: expect.any(Number), outside: 0 });
  expect(before.wide).toBeLessThanOrEqual(1);
  const link = await createInvite(page, 'ar');
  const after = await overflow(page);
  expect(after.wide, 'cashier invite (ar) after creating').toBeLessThanOrEqual(1);
  expect(after.outside).toBe(0);
  await context.close();
  if (fx!.customers.length >= 3) {
    const cctx = await customerContext(browser, 2, 'ar', { width: 375, height: 700 });
    const cpage = await cctx.newPage();
    await cpage.goto(link);
    expect(await cpage.evaluate(() => document.documentElement.dir)).toBe('rtl');
    await expect(cpage.locator('main')).toContainText(fill(loyaltyAr.customer.invite.title, { businessName: fx!.businessName }));
    const o = await overflow(cpage);
    expect(o.wide).toBeLessThanOrEqual(1);
    expect(o.outside).toBe(0);
    await cctx.close();
  }
});

for (const locale of ['en', 'ar'] as const) {
  test(`B08 no horizontal overflow at 375 px: cashier login and invalid-invitation page (${locale})`, async ({ browser }) => {
    const context = await newContext(browser, locale, { width: 375, height: 700 });
    const page = await context.newPage();
    await page.goto(`${targets.cashier}/cashier/login`);
    await page.waitForLoadState('networkidle').catch(() => {});
    const login = await overflow(page);
    expect(login.wide, `cashier login (${locale})`).toBeLessThanOrEqual(1);
    expect(login.outside).toBe(0);
    if (locale === 'ar') expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
    await context.close();
    if (fx!.customers.length >= 1) {
      const cctx = await customerContext(browser, 0, locale, { width: 375, height: 700 });
      const cpage = await cctx.newPage();
      await cpage.goto(`${targets.web}/loyalty/invite/not-a-real-invitation-token`);
      await cpage.waitForLoadState('networkidle').catch(() => {});
      const inv = await overflow(cpage);
      expect(inv.wide, `invalid invitation (${locale})`).toBeLessThanOrEqual(1);
      expect(inv.outside).toBe(0);
      await cctx.close();
    }
  });
}

test('B09 the overflow measurement itself detects an overflowing page and accepts a fitting one (a check of the instrument)', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 700 } });
  const page = await context.newPage();
  await page.setContent('<body style="margin:0"><div style="width:900px;height:10px"></div></body>');
  const wide = await overflow(page);
  expect(wide.wide).toBeGreaterThan(1);
  expect(wide.outside).toBeGreaterThan(0);
  await page.setContent('<body style="margin:0"><div style="width:300px;height:10px"></div></body>');
  expect(await overflow(page)).toEqual({ wide: 0, outside: 0 });
  await context.close();
});
