import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { collapseDevelopmentBadge } from './helpers/development-chrome';
import { signUpBusinessOwner } from './helpers/signup';

/**
 * BCOMM-01: the business Community hub in a real browser. Synthetic owner accounts only. Community stays DISABLED in this environment (no
 * enrollment, feed or publishing flag is set), so the hub must render honestly with explicit unavailable states and no invented data.
 */
const PASSWORD = 'a-strong-test-password';

async function createOwner(page: Page, label: string) {
  const unique = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `${label}-${unique}@example.test`;
  await signUpBusinessOwner(page, { fullName: `Community ${label}`, email: email, password: PASSWORD });
  // Mandatory onboarding is not bypassed: with no business the entry stays at /dashboard and asks for one.
  await expect(page).toHaveURL('/dashboard');
  await page.getByLabel('Business name').fill(`Hub ${unique}`);
  await page.getByRole('button', { name: 'Create business' }).click();
  await page.waitForURL('**/dashboard/community'); // the business now exists and the new default home has loaded
  await collapseDevelopmentBadge(page); // the development-only issue badge must not cover fixed workspace controls
  return { email, businessName: `Hub ${unique}` };
}

/**
 * Staff see their BUSINESS's language (not a cookie). The owner sets it in Settings; this test sets the same saved business setting through the
 * same API (with the owner's own session), because the Settings page is a slow, unrelated hydration-prone page on a cold development server.
 */
async function setApiBusinessLanguage(page: Page, locale: string) {
  const api = 'http://localhost:8787/api/v1';
  const access = (await page.context().cookies('http://localhost:3000')).find((c) => c.name === 'ff_access_token')?.value;
  expect(access, 'the owner session cookie').toBeTruthy();
  const auth = { authorization: `Bearer ${access}` };
  const businesses = (await (await page.request.get(`${api}/businesses`, { headers: auth })).json()) as { data: { id: string }[] };
  const saved = await page.request.patch(`${api}/businesses/me`, {
    headers: { ...auth, 'x-business-id': businesses.data[0]!.id, 'content-type': 'application/json' },
    data: { defaultLocale: locale },
  });
  expect(saved.ok()).toBe(true);
}

async function setBusinessLanguage(page: Page, locale: string) {
  await setApiBusinessLanguage(page, locale);
  await page.goto('/dashboard/community');
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}

/** Uncaught runtime errors on a page are real defects, never ignorable noise. */
function trackPageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/**
 * Sign-ups are rate limited per minute by the API, and every spec in this suite signs people up. So this file creates ONE shared owner (cookies are
 * reused by each test's own browser context) and the sign-in test logs that same owner in (logins use a separate limiter key): 1 sign-up for the whole file.
 */
let shared: { cookies: Awaited<ReturnType<BrowserContext['cookies']>>; businessName: string; email: string } | undefined;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const owner = await createOwner(page, 'shared');
  shared = { cookies: await context.cookies(), businessName: owner.businessName, email: owner.email };
  await context.close();
});

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(shared!.cookies);
  await setApiBusinessLanguage(page, 'en'); // every test starts from the default language; the language tests change it themselves
});

/** Desktop: the vertical sidebar ("Dashboard navigation"). Mobile: the bottom bar ("Business workspace"); only one is visible at a time. */
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Dashboard navigation', exact: true });
const bottomBar = (page: Page) => page.getByRole('navigation', { name: 'Business workspace', exact: true });

test('an owner lands on the Community hub; it is honest while Community is disabled; Business Overview stays reachable (desktop)', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const errors = trackPageErrors(page);
  const { businessName } = shared!;
  await page.goto('/dashboard'); // the stable entry resolves to the owner's home
  await collapseDevelopmentBadge(page);
  await expect(page).toHaveURL('/dashboard/community');
  await expect(page.getByRole('heading', { name: 'Community', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByTestId('community-business-name')).toHaveText(businessName);
  await expect(page.getByRole('heading', { name: 'One account. Every loyalty.' })).toBeVisible();
  await expect(page.getByText('Connect with customers, grow your audience and build lasting relationships through the Echo Grid Community.')).toBeVisible();

  // Real rollout state: enrollment and the Feed are closed; only business publishing is open, because the local test API opens that single
  // control (see playwright.config.ts). Nothing else is shown as open or operational.
  const rollout = page.getByTestId('community-rollout');
  await expect(rollout.getByText('Not available yet')).toHaveCount(2);
  await expect(rollout.locator('[data-capability="publishing"]')).toHaveAttribute('data-state', 'open');
  await expect(rollout.locator('[data-capability="enrollment"]')).toHaveAttribute('data-state', 'closed');
  await expect(rollout.locator('[data-capability="feed"]')).toHaveAttribute('data-state', 'closed');
  await expect(page.getByText('Community activity will appear here when Community becomes available.')).toBeVisible();
  const summary = page.getByTestId('community-summary');
  // A new business has no loyalty customers: every total is suppressed (the server never reveals a small group, not even a zero).
  await expect(summary.getByText('Hidden: small group')).toHaveCount(3);
  // No invented counts, percentages or dates anywhere on the page (only the business's own name and the stated minimum group size contain digits).
  expect((await page.getByTestId('community-hub').innerText()).replace(new RegExp(businessName, 'i'), '').replace(/smaller than 10/g, '')).not.toMatch(/\d/);

  // Navigation: Community is the first primary entry, appears once; the other business destinations remain.
  const nav = sidebar(page);
  expect(await nav.getByRole('link').first().innerText()).toBe('Community');
  await expect(nav.getByRole('link', { name: 'Community', exact: true })).toHaveCount(1);
  for (const name of ['Loyalty', 'Feedback', 'Analytics', 'Business Overview', 'Settings']) {
    await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(1);
  }
  await page.screenshot({ path: testInfo.outputPath('community-home-desktop.png'), fullPage: true });

  // Internal sections are one hub, not top-level navigation: each is unavailable, with no editor, button or invented metric.
  const tabs = page.getByRole('navigation', { name: 'Community sections' });
  await tabs.getByRole('link', { name: 'Participation' }).click();
  await expect(page).toHaveURL('/dashboard/community/participation');
  await expect(page.getByTestId('community-participation').getByText('Hidden: small group', { exact: true })).toHaveCount(3);
  await tabs.getByRole('link', { name: 'My Posts' }).click();
  await expect(page.getByTestId('community-posts')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New post' })).toBeVisible();
  await tabs.getByRole('link', { name: 'Insights' }).click();
  // A new business has no recorded activity: every figure is suppressed (never a zero), and what is not measured is stated.
  await expect(page.getByTestId('community-insights').getByText('Hidden: small group')).toHaveCount(5);
  await expect(page.getByTestId('community-insights').getByText('0', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('community-insights-notmeasured').getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('navigation', { name: 'Period' }).getByRole('link', { name: 'Last 30 days' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('navigation', { name: 'Period' }).getByRole('link', { name: 'Last 7 days' }).click();
  await expect(page).toHaveURL('/dashboard/community/insights?days=7');
  await expect(page.getByTestId('community-insights')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('community-insights-desktop.png'), fullPage: true });

  // The Business Overview keeps its own destination and its content; refreshing never loops.
  await nav.getByRole('link', { name: 'Business Overview', exact: true }).click();
  await expect(page).toHaveURL('/dashboard/overview');
  await expect(page.getByRole('heading', { name: 'Business Overview', exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL('/dashboard/overview');
  await page.goto('/dashboard');
  await expect(page).toHaveURL('/dashboard/community'); // the entry resolves to the home, once
  await page.reload();
  await expect(page).toHaveURL('/dashboard/community');
  expect(errors).toEqual([]);
});

test('mobile: the bar reads Community, Loyalty, Feedback and More; the Overview is in More; nothing overflows', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/dashboard');
  await collapseDevelopmentBadge(page);
  await expect(page).toHaveURL('/dashboard/community');
  const bottom = bottomBar(page);
  await expect(bottom.getByRole('link')).toHaveCount(3);
  await expect(bottom.getByRole('link', { name: 'Community', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(bottom.getByRole('link', { name: 'Loyalty', exact: true })).toBeVisible();
  await expect(bottom.getByRole('link', { name: 'Feedback', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('community-home-mobile.png'), fullPage: true });
  await bottom.getByRole('button', { name: 'More', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'More' });
  await sheet.getByRole('link', { name: 'Business Overview', exact: true }).click();
  await expect(page).toHaveURL('/dashboard/overview');
  await expect(page.getByRole('heading', { name: 'Business Overview', exact: true })).toBeVisible();
});

test('keyboard operation, and opening the hub sends no write request (no enrollment, consent or publication)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/dashboard/community');
  await collapseDevelopmentBadge(page);
  const writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    // The development server's own overlay posts to /__nextjs_* ; that is tooling, not the application.
    if (request.method() !== 'GET' && request.method() !== 'HEAD' && !path.startsWith('/__nextjs_')) writes.push(`${request.method()} ${path}`);
  });
  await page.goto('/dashboard/community');
  const tabs = page.getByRole('navigation', { name: 'Community sections' });
  // Real keyboard use: focus the link, press Enter. On a cold development server a late hydration can steal focus, so retry the whole gesture.
  await expect(async () => {
    await tabs.getByRole('link', { name: 'Participation' }).focus();
    await expect(tabs.getByRole('link', { name: 'Participation' })).toBeFocused({ timeout: 1_500 });
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/dashboard/community/participation', { timeout: 4_000 });
  }).toPass({ timeout: 30_000 });
  await expect(tabs.getByRole('link', { name: 'Participation' })).toHaveAttribute('aria-current', 'page');
  for (const path of ['/dashboard/community', '/dashboard/community/posts', '/dashboard/community/insights']) await page.goto(path);
  expect(writes).toEqual([]);
});

test('sign-in keeps secure return URLs and never leaves the site; the new default home is Community', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // Start signed out: the shared owner's cookies (added for every test) are cleared, then the same owner signs in.
  await context.clearCookies();
  await collapseDevelopmentBadge(page); // a page-level handler: the development-only issue badge must not cover the Log out control
  const { email } = shared!;
  const signIn = async (next: string) => {
    await page.goto(`/login?next=${encodeURIComponent(next)}`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: /^log in$|^sign in$/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));
  };
  await signIn('/dashboard/feedback'); // an authorized deep link is honoured
  await expect(page).toHaveURL('/dashboard/feedback');
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await signIn('//evil.example/phish'); // an open-redirect attempt falls back to the normal home
  await expect(page).toHaveURL('/dashboard/community');
  expect(new URL(page.url()).origin).toBe('http://localhost:3000');
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await signIn('/dashboard'); // the ordinary destination
  await expect(page).toHaveURL('/dashboard/community');
});

test('My Posts: with publishing open the composer is offered; a business with no public profile is told so and nothing is created', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const errors = trackPageErrors(page);
  await collapseDevelopmentBadge(page);
  await page.goto('/dashboard/community/posts');
  await expect(page.getByTestId('community-posts-empty')).toBeVisible();
  await expect(page.getByText('Publishing is not open yet')).toHaveCount(0);

  // Keyboard-reachable composer with labelled fields and the content rules stated up front.
  await page.getByRole('button', { name: 'New post' }).click();
  const composer = page.getByTestId('post-composer');
  await expect(composer.getByLabel('Post text')).toBeVisible();
  await expect(composer.getByLabel('Link (optional, https only)')).toBeVisible();
  await expect(composer.getByLabel('Language of the post')).toBeVisible();
  await expect(composer.getByText(/No formatting, mentions, hashtags/)).toBeVisible();

  // The API refuses to start a post for a business that has no public profile at all (posts belong to the published profile).
  await composer.getByLabel('Post text').fill('We open a second counter this Saturday.');
  await composer.getByRole('button', { name: 'Save draft' }).click();
  await expect(composer.getByRole('alert')).toContainText('Publish your business profile first');
  await page.screenshot({ path: testInfo.outputPath('community-posts-desktop.png'), fullPage: true });
  await composer.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('community-post')).toHaveCount(0);
  await expect(page.getByTestId('community-posts-empty')).toBeVisible();
  expect(errors, 'uncaught page errors').toEqual([]);
});

for (const [locale, title, tagline, dir] of [
  ['fr', 'Communauté', 'Un seul compte. Toutes vos fidélités.', 'ltr'],
  ['es', 'Comunidad', 'Una cuenta. Todas las fidelidades.', 'ltr'],
  ['ar', 'المجتمع', 'حساب واحد. كل برامج الولاء.', 'rtl'],
] as const) {
  test(`${locale}: the hub renders in the business's language (${dir})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await collapseDevelopmentBadge(page);
    await setBusinessLanguage(page, locale);
    await page.goto('/dashboard/community');
    await expect(page.locator('html')).toHaveAttribute('dir', dir);
    await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: tagline })).toBeVisible();
    await expect(page.getByTestId('community-rollout').locator('[data-state="closed"]')).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (locale === 'ar') {
      // Right-to-left: text aligns to the right edge and the tabs start on the right.
      expect(await page.getByTestId('community-hub').evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
      const first = await page.getByRole('navigation', { name: 'أقسام المجتمع' }).getByRole('link').first().boundingBox();
      const last = await page.getByRole('navigation', { name: 'أقسام المجتمع' }).getByRole('link').last().boundingBox();
      expect(first!.x).toBeGreaterThan(last!.x);
    }
    await page.screenshot({ path: testInfo.outputPath(`community-home-${locale}.png`), fullPage: true });
  });
}
