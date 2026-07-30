import { test, expect } from '@playwright/test';

/**
 * Staff-side loyalty program setup, end to end: signup -> business ->
 * create a tier -> create a reward -> update earning-rate settings.
 * Deliberately does NOT exercise the customer-facing SMS OTP flow --
 * ConsoleSmsService (customer-auth/sms.service.ts) logs the verification
 * code to the API dev server's stdout in non-production environments
 * rather than sending a real SMS, and Playwright has no reliable way to
 * read that log output back out of the webServer process this config
 * starts. Covering OTP-gated check-in/redemption end to end would need a
 * dedicated test-only backdoor (e.g. a dev-only endpoint that returns the
 * last issued code for a phone) -- flagged here as a real gap, not silently
 * skipped: recommend adding that backdoor, gated behind
 * ENVIRONMENT !== 'production' same as ConsoleSmsService itself, as a
 * follow-up if customer-flow E2E coverage becomes a priority.
 *
 * One test, not a full suite -- same skeleton/proof-of-concept framing as
 * branch-management.spec.ts and qr-engagement.spec.ts.
 */
test('staff sets up a loyalty tier, reward, and earning rates, end to end', async ({ page }) => {
  const unique = Date.now();

  await page.goto('/signup');
  await page.getByLabel('Full name').fill('Loyalty E2E Test User');
  await page.getByLabel('Email').fill(`loyalty-e2e-${unique}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('a-strong-test-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/dashboard');

  await page.getByLabel('Business name').fill(`Loyalty E2E Business ${unique}`);
  await page.getByLabel('URL slug').fill(`loyalty-e2e-business-${unique}`);
  await page.getByRole('button', { name: 'Create business' }).click();

  await page.getByRole('link', { name: 'Loyalty' }).click();
  await expect(page).toHaveURL('/dashboard/loyalty');

  // --- Tiers ---
  await page.getByRole('link', { name: 'Tiers' }).click();
  await page.getByRole('button', { name: 'New tier' }).click();
  await page.getByLabel('Name').fill('Gold');
  await page.getByLabel('Minimum points').fill('200');
  await page.getByRole('button', { name: 'Create tier' }).click();
  await expect(page.getByText('Gold').first()).toBeVisible();
  await expect(page.getByText('200+ pts')).toBeVisible();

  // --- Rewards ---
  await page.getByRole('link', { name: 'Rewards' }).click();
  await page.getByRole('button', { name: 'New reward' }).click();
  await page.getByLabel('Name').fill('Free coffee');
  await page.getByLabel('Points cost').fill('100');
  await page.getByRole('button', { name: 'Create reward' }).click();
  await expect(page.getByText('Free coffee').first()).toBeVisible();
  await expect(page.getByText('Active')).toBeVisible();

  // Deactivate it and confirm the badge flips -- a full round trip through
  // toggleRewardStatusAction, not just the create path.
  await page.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByText('Inactive')).toBeVisible();

  // --- Settings ---
  // Scoped to <main> -- the top nav also has its own "Settings" link
  // (business-wide /dashboard/settings), ambiguous with the loyalty
  // subnav's "Settings" (/dashboard/loyalty/settings) under a bare
  // getByRole('link', { name: 'Settings' }).
  await page.getByRole('main').getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Points per check-in').fill('15');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();

  // Reloading proves the value actually persisted server-side, not just in
  // local form state.
  await page.reload();
  await expect(page.getByLabel('Points per check-in')).toHaveValue('15');
});
