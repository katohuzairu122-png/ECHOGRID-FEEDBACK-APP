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
      const more = bottom.getByRole('button', { name: 'More', exact: true });
      await more.click();
      const sheet = page.getByRole('dialog', { name: 'More' });
      await expect(sheet.getByRole('link', { name: 'Billing', exact: true })).toBeVisible();
      await expect(bottom.getByRole('link')).toHaveCount(4);
      // Logout must stay on screen, inside the viewport, even on a short display.
      await page.setViewportSize({ width, height: 480 });
      const logout = sheet.getByRole('button', { name: 'Log out' });
      await expect(logout).toBeInViewport();
      await page.setViewportSize({ width, height: 900 });
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(more).toBeFocused();
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
