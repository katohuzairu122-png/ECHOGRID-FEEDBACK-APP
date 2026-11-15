import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { collapseDevelopmentBadge } from '../e2e/helpers/development-chrome';
import authEn from '../messages/en/auth.json';
import authAr from '../messages/ar/auth.json';
import dashboardEn from '../messages/en/dashboard.json';
import dashboardAr from '../messages/ar/dashboard.json';
import branchesEn from '../messages/en/branches.json';
import branchesAr from '../messages/ar/branches.json';
import feedbackEn from '../messages/en/feedback.json';
import feedbackAr from '../messages/ar/feedback.json';
import loyaltyEn from '../messages/en/loyalty.json';
import loyaltyAr from '../messages/ar/loyalty.json';

const origin = 'http://localhost:3000';
const faultFile = 'test-results/w4-unavailable';

function sql(query: string): string {
  // The Playwright config refuses any other database. The credentials below
  // belong solely to this job's disposable PostgreSQL service.
  return execFileSync('psql', [
    '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
    '-U', 'echogrid', '-d', 'echogrid_w4_test', '-c', query,
  ], { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'echogrid' } }).trim();
}

async function viewportEvidence(page: Page, name: string) {
  const info = test.info();
  for (const width of [390, 820]) {
    await page.setViewportSize({ width, height: 844 });
    await info.attach(`${name}-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name} overflow at ${width}`).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

function syntheticCustomerToken(id: string) {
  const key = /^CUSTOMER_JWT_SECRET=(.+)$/m.exec(readFileSync('../api/.dev.vars', 'utf8'))?.[1]?.trim();
  if (key !== 'replace-with-a-third-strong-random-value') throw new Error('Expected the local example signing key');
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const payload = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: id, type: 'customer_access', iat, exp: iat + 600 })}`;
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}

// Chromium's touch emulation exercises tap and pointer behavior in the same
// browser that runs the keyboard assertions. It is not physical-device coverage.
test.use({ hasTouch: true });

test.beforeEach(async ({ browser, page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await collapseDevelopmentBadge(page);
  await info.attach('browser', { body: browser.version(), contentType: 'text/plain' });
});

for (const locale of ['en', 'ar'] as const) {
  const rtl = locale === 'ar';
  const auth = (rtl ? authAr : authEn).signup;
  const dashboardMessages = rtl ? dashboardAr : dashboardEn;
  const dashboard = dashboardMessages.createBusiness;
  const branches = rtl ? branchesAr : branchesEn;
  const feedback = rtl ? feedbackAr : feedbackEn;
  const messages = (rtl ? loyaltyAr : loyaltyEn).customer.messages;
  const { more, close } = dashboardMessages.nav;

  test(`${locale} signup, form setup, and Feedback Inbox history`, async ({ page, context }) => {
    const slug = 'w4-' + randomUUID();
    await context.addCookies([{ name: 'ff_locale', value: locale, url: origin }]);
    await test.step('F1–F3 signup watermark, layout, labels, and keyboard', async () => {
      await page.goto('/signup');
      await expect(page.locator('html')).toHaveAttribute('dir', rtl ? 'rtl' : 'ltr');
      const name = page.getByLabel(auth.fullNameLabel, { exact: true });
      await expect(name).toBeVisible();
      const watermark = page.locator('main > div[aria-hidden="true"]');
      await expect(watermark.locator('svg')).toBeVisible();
      await expect(watermark).toHaveCSS('pointer-events', 'none');
      await name.focus();
      await page.keyboard.press('Tab');
      const email = page.getByLabel(auth.emailLabel, { exact: true });
      await expect(email).toBeFocused();
      await expect.soft(email).not.toHaveCSS('box-shadow', 'none');
      await viewportEvidence(page, 'signup');
      await name.fill('Synthetic زيارة');
      await email.fill(`${slug}@example.test`);
      await page.getByLabel(auth.passwordLabel, { exact: true }).fill('a-strong-test-password');
      await page.locator('#acceptTerms').check();
      await page.getByRole('button', { name: auth.submit, exact: true }).click();
      await page.getByLabel(dashboard.nameLabel, { exact: true }).fill('Central زيارة');
      await page.getByLabel(dashboard.slugLabel, { exact: true }).fill(slug);
      await page.getByRole('button', { name: dashboard.submit, exact: true }).click();
      await expect.poll(() => sql(`SELECT id FROM businesses WHERE slug = '${slug}'`)).not.toBe('');
    });
    const businessId = sql(`SELECT id FROM businesses WHERE slug = '${slug}'`);
    const branchId = sql(`
      UPDATE businesses SET default_locale = '${locale}' WHERE id = '${businessId}';
      INSERT INTO branches (business_id, name, slug) VALUES ('${businessId}', 'Central الفرع', 'w4-main') RETURNING id;
    `);
    sql(`
      WITH fixture_qr AS (
        INSERT INTO qr_codes (business_id, branch_id) VALUES ('${businessId}', '${branchId}') RETURNING id
      )
      INSERT INTO feedback (business_id, branch_id, qr_code_id, rating, comment, category, urgency, analysis_status, created_at)
        SELECT '${businessId}', '${branchId}', id, 3, 'زيارة W4 ' || n, 'service_quality', 'P1_HIGH',
               'manual', now() - n * interval '1 minute'
        FROM fixture_qr CROSS JOIN generate_series(1, 21) AS n;
    `);

    await test.step('F1–F3 quick form publication and advanced disclosure', async () => {
      await page.goto('/dashboard/feedback/forms');
      await expect(page.locator('html')).toHaveAttribute('dir', rtl ? 'rtl' : 'ltr');
      const builder = page.locator('form').filter({ has: page.getByLabel(feedback.formBuilder.name) }).first();
      await builder.getByLabel(feedback.formBuilder.name).fill('زيارة W4 Form');
      const question = builder.getByLabel(feedback.formBuilder.question);
      await question.fill('How was the visit? كيف كانت الزيارة؟');
      await question.focus();
      await page.keyboard.press('Tab');
      const summary = builder.locator('summary').first();
      await expect(summary).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(builder.locator('details').first()).toHaveAttribute('open', '');
      await viewportEvidence(page, 'form');
      await builder.getByRole('button', { name: feedback.formBuilder.publish, exact: true }).click();
      await expect(page.getByRole('heading', { name: /زيارة W4 Form.*v1/ })).toBeVisible();
    });

    await test.step('W5 touch navigation, modal keyboard containment and breakpoint cleanup', async () => {
      await page.goto('/dashboard/feedback');
      const trigger = page.getByRole('button', { name: more, exact: true });
      const sheet = page.getByRole('dialog', { name: more, exact: true });
      await expect(trigger).toBeVisible();
      await expect(async () => {
        await trigger.tap();
        await expect(sheet).toBeVisible({ timeout: 1_500 });
      }).toPass({ timeout: 12_000 });
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(sheet).toHaveAttribute('aria-modal', 'true');
      await expect.poll(() => sheet.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');

      const dismiss = sheet.getByRole('button', { name: close, exact: true });
      await dismiss.focus();
      await page.keyboard.press('Shift+Tab');
      expect(await sheet.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      await expect(dismiss).not.toBeFocused();
      await page.keyboard.press('Tab');
      await expect(dismiss).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');

      await trigger.tap();
      await expect(sheet).toBeVisible();
      await page.setViewportSize({ width: 1200, height: 844 });
      await expect(sheet).toHaveCount(0);
      await expect(trigger).toBeHidden();
      await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(trigger).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');

      await trigger.tap();
      await expect(sheet).toBeVisible();
      const link = sheet.locator('nav a[href]').first();
      const target = await link.getAttribute('href');
      expect(target).toMatch(/^\/dashboard/);
      await link.tap();
      await expect.poll(() => new URL(page.url()).pathname).toBe(target);
      await expect(sheet).toHaveCount(0);
    });

    await test.step('W5 touch form dialog and keyboard focus restoration', async () => {
      await page.goto('/dashboard/branches');
      const trigger = page.getByRole('button', { name: branches.newButton, exact: true });
      const dialog = page.getByRole('dialog', { name: branches.form.titleNew, exact: true });
      await expect(async () => {
        await trigger.tap();
        await expect(dialog).toBeVisible({ timeout: 1_500 });
      }).toPass({ timeout: 12_000 });
      const name = dialog.getByLabel(branches.form.nameLabel, { exact: true });
      await name.tap();
      await name.fill('فرع W5 North');
      await page.keyboard.press('Tab');
      await expect(dialog.getByLabel(branches.form.slugLabel, { exact: true })).toBeFocused();
      await expect.poll(() => dialog.evaluate((node) => getComputedStyle(node).direction)).toBe(rtl ? 'rtl' : 'ltr');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
    });

    await test.step('F4 filters, committed history, pagination and results', async () => {
      await page.goto('/dashboard/feedback');
      const branch = page.getByRole('combobox', { name: feedback.staff.filterAriaLabel });
      const category = page.getByRole('combobox', { name: feedback.staff.categoryFilterLabel, exact: true });
      const urgency = page.getByRole('combobox', { name: feedback.staff.urgencyFilterLabel, exact: true });
      const selected = async (offset: string | null) => {
        const query = new URL(page.url()).searchParams;
        expect(query.get('branchId')).toBe(branchId);
        expect(query.get('category')).toBe('service_quality');
        expect(query.get('urgency')).toBe('P1_HIGH');
        expect(query.get('offset')).toBe(offset);
        await expect(branch).toHaveValue(branchId);
        await expect(category).toHaveValue('service_quality');
        await expect(urgency).toHaveValue('P1_HIGH');
        await expect(page.getByRole('article')).toHaveCount(offset ? 1 : 20);
      };
      await branch.selectOption(branchId);
      await expect(page).toHaveURL(/branchId=/);
      await category.selectOption('service_quality');
      await expect(page).toHaveURL(/category=service_quality/);
      await urgency.selectOption('P1_HIGH');
      await expect(page).toHaveURL(/urgency=P1_HIGH/);
      await selected(null);
      await viewportEvidence(page, 'inbox');
      await page.getByRole('link', { name: feedback.staff.older }).click();
      await expect(page).toHaveURL(/offset=20/);
      await selected('20');
      await page.goBack();
      await selected(null);
      await page.goForward();
      await selected('20');
      await page.reload();
      await selected('20');
      await category.selectOption('');
      await expect(category).toHaveValue('');
      await expect(urgency).toHaveValue('P1_HIGH');
      await expect(branch).toHaveValue(branchId);
      await page.getByRole('button', { name: feedback.staff.clearFilters, exact: true }).click();
      await expect(urgency).toHaveValue('');
      await expect(branch).toHaveValue(branchId);
      await branch.selectOption('');
      await expect(page).toHaveURL(/\/dashboard\/feedback$/);
      await expect(page.getByRole('article')).toHaveCount(20);
    });

    await test.step('W5 keyboard filters and touch pagination after scrolling', async () => {
      const urgency = page.getByRole('combobox', { name: feedback.staff.urgencyFilterLabel, exact: true });
      await urgency.focus();
      await urgency.press('ArrowDown');
      await expect(page).toHaveURL(/urgency=P0_CRITICAL/);
      await expect(urgency).toHaveValue('P0_CRITICAL');
      await expect(page.getByRole('heading', { name: feedback.staff.noResultsTitle })).toBeVisible();
      await page.getByRole('button', { name: feedback.staff.clearFilters, exact: true }).first().tap();
      await expect(page).toHaveURL(/\/dashboard\/feedback$/);
      const older = page.getByRole('link', { name: feedback.staff.older });
      await older.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      await older.tap();
      await expect(page).toHaveURL(/offset=20/);
      await expect(page.getByRole('article')).toHaveCount(1);
    });
  });

  test(`${locale} customer Messages recovery and keyboard retry`, async ({ page, context }) => {
    const id = randomUUID();
    const business = randomUUID();
    const thread = randomUUID();
    const phone = rtl ? '+15550100442' : '+15550100441';
    sql(`
      INSERT INTO businesses (id, name, slug, default_locale) VALUES ('${business}', 'W4 زيارة', 'w4-${business}', '${locale}');
      INSERT INTO customers (id, phone, phone_verified_at, preferred_locale) VALUES ('${id}', '${phone}', now(), '${locale}');
      INSERT INTO loyalty_accounts (business_id, customer_id) VALUES ('${business}', '${id}');
      INSERT INTO conversations (id, business_id, customer_id) VALUES ('${thread}', '${business}', '${id}');
      INSERT INTO messages (conversation_id, sender_type, sender_id, body) VALUES ('${thread}', 'staff', gen_random_uuid(), 'Synthetic W4 رسالة');
    `);
    await context.addCookies([{ name: 'ff_customer_token', value: syntheticCustomerToken(id), httpOnly: true, url: origin }]);
    const url = `/loyalty/dashboard/${business}/messages`;
    mkdirSync('test-results', { recursive: true });
    writeFileSync(faultFile, '');
    try {
      await page.goto(url);
      await expect(page.locator('html')).toHaveAttribute('dir', rtl ? 'rtl' : 'ltr');
      const failureNotice = page.getByRole('alert').filter({ hasText: messages.loadErrorTitle });
      await expect(failureNotice).toBeVisible();
      await viewportEvidence(page, 'messages-retry');
      const retry = page.getByRole('button', { name: messages.retry, exact: true });
      await retry.focus();
      await expect(retry).toBeFocused();
      await expect.soft(retry).not.toHaveCSS('box-shadow', 'none');
      rmSync(faultFile, { force: true });
      await page.keyboard.press('Enter');
      await expect(page.getByText('Synthetic W4 رسالة')).toBeVisible();
      await expect(failureNotice).toHaveCount(0);
      await viewportEvidence(page, 'messages-recovered');

      await test.step('W5 touch retry after a second synthetic interruption', async () => {
        writeFileSync(faultFile, '');
        await page.reload();
        await expect(failureNotice).toBeVisible();
        await expect(page.getByText('Synthetic W4 رسالة')).toHaveCount(0);
        rmSync(faultFile, { force: true });
        await retry.tap();
        await expect(page.getByText('Synthetic W4 رسالة')).toBeVisible();
        await expect(failureNotice).toHaveCount(0);
      });
    } finally {
      rmSync(faultFile, { force: true });
    }
  });
}
