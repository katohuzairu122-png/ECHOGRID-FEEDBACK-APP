import { test, expect } from '@playwright/test';

/**
 * The full scan-to-inbox loop -- the single most important proof this
 * module actually works end to end: a signup, a branch, its QR code's
 * token read straight off the dashboard (no real QR scanner needed for a
 * test), a real anonymous submission on the public landing page in a
 * SEPARATE unauthenticated browser context (a real customer never shares
 * the business owner's session), and that submission showing up back in
 * the authenticated feedback inbox.
 *
 * Deliberately ONE test, not a full suite -- same skeleton/proof-of-concept
 * framing as branch-management.spec.ts, not exhaustive E2E coverage. Needs
 * apps/api's dev server pointed at a real, migrated+seeded database;
 * unverified this session (sandbox has been down all session).
 */
test('QR code scan to feedback inbox, end to end', async ({ page }) => {
  const unique = Date.now();

  await page.goto('/signup');
  await page.getByLabel('Full name').fill('QR E2E Test User');
  await page.getByLabel('Email').fill(`qr-e2e-${unique}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('a-strong-test-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/dashboard');

  await page.getByLabel('Business name').fill(`QR E2E Business ${unique}`);
  await page.getByLabel('URL slug').fill(`qr-e2e-business-${unique}`);
  await page.getByRole('button', { name: 'Create business' }).click();

  await page.getByRole('link', { name: 'View branches' }).click();
  await page.getByRole('button', { name: '+ New branch' }).click();
  await page.getByLabel('Name').fill('Main');
  await page.getByLabel('URL slug').fill('main');
  await page.getByRole('button', { name: 'Create branch' }).click();
  await expect(page.getByText('Main').first()).toBeVisible();

  await page.getByRole('button', { name: 'QR code' }).click();
  const feedbackUrl = (await page.getByText(/\/feedback\//).textContent())?.trim();
  expect(feedbackUrl).toBeTruthy();
  await page.getByRole('button', { name: 'Close' }).click();

  // A real customer never shares the business owner's session -- a fresh,
  // unauthenticated browser context for the scan-and-submit half of the flow.
  const customerContext = await page.context().browser()!.newContext();
  const customerPage = await customerContext.newPage();
  await customerPage.goto(feedbackUrl!);

  await expect(customerPage.getByRole('heading', { name: 'How was your visit?' })).toBeVisible();
  // force: true -- StarRating (components/ui/star-rating.tsx) renders each
  // radio input visually-hidden (sr-only) inside a styled <label>; real
  // users and screen readers interact with the label/input pair natively,
  // but Playwright's actionability check clicks the input's own (now
  // off-screen) box and sees the label geometrically on top of it.
  await customerPage.getByRole('radio', { name: '5 stars' }).click({ force: true });
  await customerPage.getByLabel('Comments (optional)').fill('Excellent service, E2E test.');
  await customerPage.getByRole('button', { name: 'Submit feedback' }).click();

  await expect(customerPage.getByText('Thank you!')).toBeVisible();
  await customerContext.close();

  // Back in the dashboard: the anonymous submission shows up in the inbox.
  await page.getByRole('link', { name: 'Feedback' }).click();
  await expect(page).toHaveURL('/dashboard/feedback');
  await expect(page.getByText('Excellent service, E2E test.')).toBeVisible();
});
