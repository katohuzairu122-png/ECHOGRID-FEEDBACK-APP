import { test, expect } from '@playwright/test';
import { collapseDevelopmentBadge } from './helpers/development-chrome';

test('Business Overview uses empty API data honestly and keeps navigation responsive', async ({
  page,
}, testInfo) => {
  const unique = Date.now();
  await page.goto('/signup');
  await page.getByLabel('Full name').fill('Workspace UI Test');
  await page.getByLabel('Email').fill(`workspace-${unique}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('a-strong-test-password');
  await page.getByLabel(/I agree to the Terms of Service/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Business name').fill(`Workspace ${unique}`);
  await page.getByLabel('URL slug').fill(`workspace-${unique}`);
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page.getByRole('heading', { name: 'Business Overview', exact: true })).toBeVisible();
  await expect(page.getByText('No feedback to display yet.', { exact: true })).toBeVisible();
  await expect(
    page.getByText('No loyalty accounts to display yet.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('No unresolved high-priority feedback.', { exact: true }),
  ).toBeVisible();
  const loyalty = page.getByRole('article', { name: 'Loyalty accounts shown' });
  await expect(loyalty.locator('strong')).toHaveText('0');
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`business-overview-${width}.png`),
      fullPage: true,
    });
    if (width < 1024) {
      const bottom = page.getByRole('navigation', { name: 'Business workspace', exact: true });
      await expect(
        bottom.getByRole('link', { name: 'Business Overview', exact: true }),
      ).toHaveAttribute('aria-current', 'page');
      const summary = page.locator('summary[aria-label="Dashboard navigation"]');
      await summary.click();
      await expect(
        page.locator('details').getByRole('link', { name: 'Billing', exact: true }),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(summary).toBeFocused();
      await expect(page.locator('details')).not.toHaveAttribute('open');
    }
  }
  await page.setViewportSize({ width: 360, height: 900 });
  await collapseDevelopmentBadge(page);
  await page
    .getByRole('navigation', { name: 'Business workspace', exact: true })
    .getByRole('link', { name: 'Feedback', exact: true })
    .click();
  await expect(page).toHaveURL(/\/dashboard\/feedback$/);
  await expect(page.getByRole('heading', { name: 'Feedback', exact: true })).toBeVisible();
});
