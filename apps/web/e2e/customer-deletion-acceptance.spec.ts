import { test, expect, type Page } from '@playwright/test';

test.skip(process.env.CUSTOMER_AUTH_R5_TEST_ONLY !== 'true', 'Disposable customer-auth fixture only');
test.describe.configure({ mode: 'serial' });

const api = 'http://127.0.0.1:8792';
const fixtureHeaders = { Authorization: `Bearer ${process.env.CUSTOMER_AUTH_R5_MAILBOX_TOKEN ?? ''}` };
const recipient = (process.env.E2E_CUSTOMER_EMAIL ?? '').replace('@', '-deletion@');
const password = process.env.E2E_CUSTOMER_PASSWORD ?? '';

async function registrationLink(page: Page): Promise<string> {
  const response = await page.request.get(
    api + '/__test/mailbox?recipient=' + encodeURIComponent(recipient),
    { headers: fixtureHeaders },
  );
  expect(response.status()).toBe(200);
  const messages = (await response.json()).messages as Array<{ html: string }>;
  const link = [...messages].reverse().find((m) => m.html.includes('/loyalty/signup/verify'))
    ?.html.match(/href="([^"]+)"/)?.[1];
  expect(Boolean(link)).toBe(true);
  return link!.replaceAll('&amp;', '&');
}

test('CUST-DEL-02 — password step-up, request, revocation, restricted dashboard and restore', async ({ page }) => {
  await page.goto('/loyalty/signup');
  await page.getByLabel('Name', { exact: true }).fill('Synthetic deletion customer');
  await page.getByLabel('Email', { exact: true }).fill(recipient);
  await page.getByLabel('Choose a password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Send confirmation link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await registrationLink(page));
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/loyalty\/dashboard(?:\?|$)/);

  await page.goto('/loyalty/dashboard/settings');
  await expect(page.getByRole('heading', { name: 'Delete my account data' })).toBeVisible();
  await page.locator('#deletion-password').fill('incorrect-current-password');
  await page.getByRole('checkbox', { name: /I understand that all sessions/ }).check();
  await page.getByRole('button', { name: 'Request account deletion' }).click();
  await expect(page.getByText('Confirm your password and acknowledgement.', { exact: true })).toBeVisible();

  // React resets uncontrolled form controls after the failed Server Action.
  // A subsequent attempt must explicitly acknowledge the deletion again.
  await page.locator('#deletion-password').fill(password);
  await page.getByRole('checkbox', { name: /I understand that all sessions/ }).check();
  await page.getByRole('button', { name: 'Request account deletion' }).click();
  await expect(page).toHaveURL(/\/loyalty\/login\?next=/);

  await page.goto('/loyalty/login/email?next=%2Floyalty%2Fdeletion%2Fpending');
  await page.getByLabel('Email', { exact: true }).fill(recipient);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  try {
    try {
    await expect(page).toHaveURL(/\/loyalty\/deletion\/pending/);
  } catch (error) {
    const alerts = await page.getByRole('alert').allTextContents();
    throw new Error(`Pending-account sign-in failed; validation category: ${alerts.join(' | ') || 'none'}; original: ${String(error)}`);
  }
  } catch {
    const errors = await page.locator('p[role="alert"]').allTextContents();
    throw new Error(`Pending sign-in did not navigate; error category: ${errors.join(' | ') || 'none'}`);
  }
  await expect(page.getByRole('heading', { name: 'Your account deletion is pending' })).toBeVisible();

  await page.goto('/loyalty/dashboard');
  await expect(page).toHaveURL(/\/loyalty\/deletion\/pending/);
  await page.getByRole('button', { name: 'Restore my account' }).click();
  await expect(page).toHaveURL(/\/loyalty\/dashboard(?:\?|$)/);
  await page.goto('/loyalty/dashboard/settings');
  await expect(page.getByRole('heading', { name: 'Delete my account data' })).toBeVisible();
});
