import { test, expect, type Page } from '@playwright/test';
import { collapseDevelopmentBadge } from './helpers/development-chrome';
import { signUpBusinessOwner } from './helpers/signup';

/**
 * BIZ-CLOSE-01 in a real browser: the owner's closure REQUEST. Synthetic owner only; no real business is closed (a request closes nothing).
 * One sign-up for the whole file (sign-ups are rate limited per minute).
 */
const PASSWORD = 'a-strong-test-password';
const unique = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const BUSINESS = `Closure ${unique.replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)] as string)}`;

async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test('the owner reviews the blocked state, confirms, files, sees it pending, withdraws; desktop and mobile', async ({ page }) => {
  const errors: string[] = [];
  // The existing Settings page has a development-only currency-name hydration mismatch (Node vs Chromium Intl); only errors raised on the
  // closure page itself are this feature's.
  page.on('pageerror', (e) => { if (page.url().includes('/settings/closure')) errors.push(e.message); });
  await signUpBusinessOwner(page, { fullName: 'Closure Owner', email: `closure-${unique}@example.test`, password: PASSWORD });
  await expect(page).toHaveURL('/dashboard');
  await page.getByLabel('Business name').fill(BUSINESS);
  await page.getByRole('button', { name: 'Create business' }).click();
  await page.waitForURL('**/dashboard/community');
  await collapseDevelopmentBadge(page);

  // The Settings page offers the entry to the owner only.
  await page.goto('/dashboard/settings');
  await expect(page.getByRole('link', { name: 'Review and request closure' })).toHaveAttribute('href', '/dashboard/settings/closure');
  await page.goto('/dashboard/settings/closure'); // direct: the Settings page hydrates slowly on a cold development server

  // Controlled blocked state, no processing control of any kind.
  await expect(page.getByRole('heading', { name: 'Closure cannot be processed yet' })).toBeVisible();
  await expect(page.getByText('The closure, settlement and record-retention rules are not approved yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: /process|approve|complete|delete|close now/i })).toHaveCount(0);

  // Filing without the password proof is refused with a clear message and records nothing.
  await page.getByLabel(/Type ".*" to confirm/).fill(BUSINESS);
  await page.getByRole('button', { name: 'Request closure' }).click();
  await expect(page.getByText('Confirm your password first, then try again.')).toBeVisible();

  // Wrong password, then the right one.
  await page.getByLabel('Your password').fill('definitely-wrong-1');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('That password is not correct.')).toBeVisible();
  await page.getByLabel('Your password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText(/Confirmed\. You have 5 minutes/)).toBeVisible();

  // A mistyped name is refused; the exact name files the request.
  await page.getByLabel(/Type ".*" to confirm/).fill('Not the name');
  await page.getByRole('button', { name: 'Request closure' }).click();
  await expect(page.getByText('The name you typed does not match the business name.')).toBeVisible();
  await page.getByLabel(/Type ".*" to confirm/).fill(BUSINESS);
  await page.getByRole('button', { name: 'Request closure' }).click();
  await expect(page.getByRole('heading', { name: 'A closure request is open' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request closure' })).toHaveCount(0); // idempotent: no second request offered
  await expect(page.getByText(/Nothing has been deleted or changed/).first()).toBeVisible();

  // The business keeps operating: the dashboard is still reachable.
  await page.goto('/dashboard/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.goto('/dashboard/settings/closure');

  // Mobile: no horizontal overflow, controls reachable.
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.getByRole('button', { name: 'Withdraw request' })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1280, height: 800 });

  // Withdraw (the 5 minute proof is still valid).
  await page.getByRole('button', { name: 'Withdraw request' }).click();
  await expect(page.getByRole('heading', { name: 'A closure request is open' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Request closure' })).toBeVisible();
  expect(errors).toEqual([]);
});
