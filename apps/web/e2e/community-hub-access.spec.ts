import { test, expect } from '@playwright/test';
import { signUpBusinessOwner } from './helpers/signup';

const HUB = '/loyalty/dashboard/community';

/** The Community hub is customer-only: unauthenticated, invalid and staff-only visitors all land on the customer login. */
test.describe('Community hub access', () => {
  test('redirects a visitor with no session to the customer login', async ({ page }) => {
    await page.goto(HUB);
    await expect(page).toHaveURL(/\/loyalty\/login/);
  });

  test('redirects an invalid customer token to the customer login instead of rendering data', async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { name: 'ff_customer_token', value: 'not-a-real-token', url: 'http://localhost:3000' },
    ]);
    await page.goto(HUB);
    await expect(page).toHaveURL(/\/loyalty\/login/);
    await expect(page.getByTestId('community-balance')).toHaveCount(0);
  });

  test('does not accept a staff session as customer authentication', async ({ page }) => {
    const unique = Date.now();
    await signUpBusinessOwner(page, { fullName: 'Community Access Test', email: `community-access-${unique}@example.test`, password: 'a-strong-test-password' });
    await expect(page).toHaveURL(/\/dashboard/);
    await page.goto(HUB);
    await expect(page).toHaveURL(/\/loyalty\/login/);
  });
});
