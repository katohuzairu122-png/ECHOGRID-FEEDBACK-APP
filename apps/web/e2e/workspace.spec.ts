import { test, expect } from '@playwright/test';
import { collapseDevelopmentBadge } from './helpers/development-chrome';
import { signUpBusinessOwner } from './helpers/signup';

test('Business Overview uses empty API data honestly and keeps navigation responsive', async ({
  page,
}, testInfo) => {
  const unique = Date.now();
  await signUpBusinessOwner(page, { fullName: 'Workspace UI Test', email: `workspace-${unique}@example.test`, password: 'a-strong-test-password' });
  await page.getByLabel('Business name').fill(`Workspace ${unique}`);
  await page.getByRole('button', { name: 'Create business' }).click();
  // BCOMM-01: a new owner lands on the Community hub; these specs exercise the Business Overview, which keeps its own destination.
  await expect(page.getByRole('heading', { name: 'Community', exact: true })).toBeVisible();
  await page.goto('/dashboard/overview');
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
      // BCOMM-01: the bar shows Community, Loyalty and Feedback (customers and rewards live inside Loyalty); the Overview is in More.
      await expect(bottom.getByRole('link')).toHaveCount(3);
      await expect(bottom.getByRole('link', { name: 'Community', exact: true })).toBeVisible();
      const more = bottom.getByRole('button', { name: 'More', exact: true });
      await more.click();
      const sheet = page.getByRole('dialog', { name: 'More' });
      await expect(
        sheet.getByRole('link', { name: 'Business Overview', exact: true }),
      ).toHaveAttribute('aria-current', 'page');
      await expect(sheet.getByRole('link', { name: 'Billing', exact: true })).toBeVisible();
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
