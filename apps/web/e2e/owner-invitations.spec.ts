import { test, expect, type Page } from '@playwright/test';
import { collapseDevelopmentBadge } from './helpers/development-chrome';
import { signUpBusinessOwner } from './helpers/signup';

/**
 * OWNER-INVITE-01 in a real browser: customer invitations inside the owner-facing Cashier App (desktop, 375 px mobile, Arabic RTL). Synthetic owner only.
 * One sign-up for the file. The cashier PWA surface has no invitation page (covered by unit tests); here the owner flow is exercised end to end.
 */
const PASSWORD = 'a-strong-test-password';
const unique = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const API = 'http://localhost:8787/api/v1';

async function ownerAuth(page: Page) {
  const access = (await page.context().cookies('http://localhost:3000')).find((c) => c.name === 'ff_access_token')?.value;
  expect(access, 'owner session cookie').toBeTruthy();
  const auth = { authorization: `Bearer ${access}` };
  const businesses = (await (await page.request.get(`${API}/businesses`, { headers: auth })).json()) as { data: { id: string }[] };
  return { auth, businessId: businesses.data[0]!.id };
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('owner creates, shares and revokes a customer invitation inside the Cashier App; mobile and Arabic RTL', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => { if (page.url().includes('/cashier/invitations')) errors.push(e.message); });
  await signUpBusinessOwner(page, { fullName: 'Invite Owner', email: `invite-${unique}@example.test`, password: PASSWORD });
  await expect(page).toHaveURL('/dashboard');
  await page.getByLabel('Business name').fill(`Invite ${unique.replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)] as string)}`);
  await page.getByRole('button', { name: 'Create business' }).click();
  await page.waitForURL('**/dashboard/community');
  await collapseDevelopmentBadge(page);
  const { auth, businessId } = await ownerAuth(page);
  const branch = await page.request.post(`${API}/branches`, { headers: { ...auth, 'x-business-id': businessId, 'content-type': 'application/json' }, data: { name: 'Main Counter' } });
  expect(branch.ok(), await branch.text()).toBe(true);

  // The entry lives INSIDE the Cashier App page.
  await page.goto('/dashboard/cashier');
  await expect(page.getByRole('link', { name: 'Invite customers' })).toHaveAttribute('href', '/dashboard/cashier/invitations');

  await page.goto('/dashboard/cashier/invitations');
  await expect(page.getByRole('heading', { name: 'Invite customers', level: 1 })).toBeVisible();
  await expect(page.getByText(/does not enrol anyone/)).toBeVisible();
  await page.getByRole('button', { name: 'Create invitation' }).click();
  const created = page.getByTestId('invitation-created');
  await expect(created).toBeVisible({ timeout: 20_000 });
  const link = await created.getByRole('textbox', { name: 'Invitation link' }).inputValue();
  expect(link).toMatch(/\/loyalty\/invite\/[\w.-]+$/);
  await expect(created.locator('svg').first()).toBeVisible(); // the QR
  await expect(page.getByTestId('invitation-counts')).toContainText('Active: 1');

  // Mobile fit.
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1280, height: 800 });

  // Revoke.
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByTestId('invitation-counts')).toContainText('Revoked: 1', { timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Revoke' })).toHaveCount(0);

  // The revoked link no longer previews for a customer (generic invalid page, no join control).
  await page.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await expect(page.getByRole('button', { name: /^Join/ })).toHaveCount(0);

  // Arabic, right-to-left.
  const patched = await page.request.patch(`${API}/businesses/me`, { headers: { ...auth, 'x-business-id': businessId, 'content-type': 'application/json' }, data: { defaultLocale: 'ar' } });
  expect(patched.ok()).toBe(true);
  await page.goto('/dashboard/cashier/invitations');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'دعوة العملاء', level: 1 })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
