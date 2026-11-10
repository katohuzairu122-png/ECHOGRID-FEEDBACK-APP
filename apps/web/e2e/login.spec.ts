import { test, expect } from '@playwright/test';

// Runs with the existing disposable API/database fixture in CI. Never use
// this account-creating test against production (the remote config rejects it).
test('landing sign in, registration, failed login, session login, logout and protected redirect', async ({
  page,
  context,
}) => {
  const email = `login-ui-${Date.now()}@example.test`;
  const password = 'a-strong-login-test-password';
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByRole('link', { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByLabel('Email', { exact: true })).toBeFocused();
  await page.getByLabel('Email', { exact: true }).fill('invalid-email');
  expect(
    await page
      .getByLabel('Email', { exact: true })
      .evaluate((input: HTMLInputElement) => input.validity.typeMismatch),
  ).toBe(true);
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign up', exact: true }).click();
  await page.getByLabel('Full name').fill('Login UI Test');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel(/I agree to the Terms of Service/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  const loginError = page.locator('form').getByRole('alert');
  await expect(loginError).toBeVisible();
  await expect(loginError).toBeFocused();
  expect(
    (await context.cookies()).filter((cookie) => cookie.name === 'ff_access_token'),
  ).toHaveLength(0);

  // React may reset uncontrolled fields after a completed Server Action.
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide password' }).click();
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const session = (await context.cookies()).filter((cookie) =>
    ['ff_access_token', 'ff_refresh_token'].includes(cookie.name),
  );
  expect(session).toHaveLength(2);
  expect(session.every((cookie) => cookie.httpOnly && cookie.sameSite === 'Lax')).toBe(true);
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await context.cookies()).filter((cookie) => cookie.name.startsWith('ff_'))).toHaveLength(
    0,
  );
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
});

test('login and landing sign-in navigation fit mobile, tablet and desktop', async ({
  page,
}, testInfo) => {
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    // Scope the tablet link to the open menu: both header and menu CTAs
    // intentionally exist at tablet widths in the deployed landing design.
    const menu = page.locator('header details').filter({ has: page.locator('a[href="/login"]') });
    if (await menu.isVisible()) {
      await menu.locator('summary').click();
      await menu.getByRole('link', { name: /^sign in$/i }).click();
    } else {
      await page.getByRole('link', { name: /^sign in$/i }).click();
    }
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const input = page.getByLabel('Email', { exact: true });
    const bounds = await input.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`login-${width}.png`), fullPage: true });
  }
});
