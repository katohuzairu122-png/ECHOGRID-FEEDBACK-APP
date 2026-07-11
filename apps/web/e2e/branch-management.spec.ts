import { test, expect } from '@playwright/test';

/**
 * One critical-path smoke test covering the full stack the Vitest/jsdom
 * layer structurally cannot reach: a real signup, real httpOnly session
 * cookies set by a Server Action, a real Server Component fetch to the
 * Hono API, and a real branch create/list round trip.
 *
 * Deliberately a SINGLE test, not a full suite -- this is the skeleton and
 * proof-of-concept for this test tier (mirroring how apps/api's
 * test:workers started as two smoke tests), not exhaustive E2E coverage.
 * Needs apps/api's dev server pointed at a real database with migrations
 * and `pnpm db:seed` already applied; unverified this session.
 */
test('signup, create a business, create a branch, see it listed', async ({ page }) => {
  const unique = Date.now();

  await page.goto('/signup');
  await page.getByLabel('Full name').fill('E2E Test User');
  await page.getByLabel('Email').fill(`e2e-${unique}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('a-strong-test-password');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page).toHaveURL('/dashboard');

  await page.getByLabel('Business name').fill(`E2E Business ${unique}`);
  await page.getByLabel('URL slug').fill(`e2e-business-${unique}`);
  await page.getByRole('button', { name: 'Create business' }).click();

  await expect(page.getByRole('heading', { name: `E2E Business ${unique}` })).toBeVisible();

  await page.getByRole('link', { name: 'View branches' }).click();
  await expect(page).toHaveURL('/dashboard/branches');

  await page.getByRole('button', { name: '+ New branch' }).click();
  await page.getByLabel('Name').fill('Main');
  await page.getByLabel('URL slug').fill('main');
  await page.getByRole('button', { name: 'Create branch' }).click();

  await expect(page.getByText('Main').first()).toBeVisible();
  await expect(page.getByText('/main')).toBeVisible();
});
