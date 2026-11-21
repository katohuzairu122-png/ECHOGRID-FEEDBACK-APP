import { test, expect, type Page } from '@playwright/test';

/**
 * CUSTOMER EMAIL SIGN-UP (Option A) ACCEPTANCE SPECIFICATION - staging only, opt-in.
 *
 * STATUS: development-only; new single-pass registration cases need exact-head browser acceptance. Email authentication is OFF in every deployed
 * environment (CUSTOMER_EMAIL_AUTH_ENABLED=false). These tests are skipped unless explicitly enabled, so the default
 * CI run and local `playwright test` are unaffected. Enable only against a disposable/staging stack where an
 * authorised operator has turned the flag on for BOTH Workers (see docs/runbooks/CUSTOMER_EMAIL_AUTH_STAGING.md).
 *
 * Enable with:   E2E_CUSTOMER_EMAIL_AUTH=1  E2E_BASE_URL=<staging web origin>  (use playwright.remote.config.ts,
 * which refuses production hosts).
 *
 * The confirmation link is delivered by email (Resend). Playwright cannot read that mailbox, so the operator supplies
 * the link out of band for the one test that needs it:
 *   E2E_CUSTOMER_VERIFY_URL   the full /loyalty/signup/verify?... link from the delivered email
 *   E2E_CUSTOMER_EMAIL        the address the link was requested for (must be an @example.test-style test address)
 *   E2E_CUSTOMER_PASSWORD     the password submitted at the original signup step
 * Optional phone attachment needs a staging phone number and the code read from the Worker logs (the console SMS service logs it):
 *   E2E_CUSTOMER_PHONE, E2E_CUSTOMER_PHONE_CODE
 * Legacy compatibility needs an already-issued legacy customer session token for a customer WITHOUT a verified login
 * email:  E2E_LEGACY_CUSTOMER_TOKEN
 */
const enabled = process.env.E2E_CUSTOMER_EMAIL_AUTH === '1';
test.skip(!enabled, 'Customer email auth acceptance is opt-in: set E2E_CUSTOMER_EMAIL_AUTH=1 against a staging stack.');

const email = process.env.E2E_CUSTOMER_EMAIL ?? '';
const password = process.env.E2E_CUSTOMER_PASSWORD ?? '';
const verifyUrl = process.env.E2E_CUSTOMER_VERIFY_URL ?? '';
const legacyToken = process.env.E2E_LEGACY_CUSTOMER_TOKEN ?? '';

async function signIn(page: Page, address: string, pw: string) {
  await page.goto('/loyalty/login/email');
  await page.getByLabel('Email').fill(address);
  await page.getByLabel('Password').fill(pw);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe.configure({ mode: 'serial' });

test.describe('registration', () => {
  test('requesting a link is non-enumerating: the same confirmation is shown for any address', async ({ page }) => {
    await page.goto('/loyalty/signup');
    await page.getByLabel('Name').fill('Synthetic E2E Customer');
    await page.getByLabel('Email').fill(`e2e-reg-${Date.now()}@example.test`);
    await page.getByLabel('Choose a password').fill('secure-e2e-password-42');
    await page.getByLabel('Confirm password').fill('secure-e2e-password-42');
    await page.getByRole('button', { name: 'Send confirmation link' }).click();
    await expect(page.getByText('Check your email')).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveCount(0);
  });

  test('a verification link without its parameters is refused with a way to request a new one', async ({ page }) => {
    await page.goto('/loyalty/signup/verify');
    await expect(page.getByText(/link is incomplete/i)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible();
  });
});

test.describe('one-time signup verification and session activation', () => {
  test.skip(!verifyUrl || !email, 'needs E2E_CUSTOMER_VERIFY_URL and the matching synthetic email from the delivered message');

  test('requires no repeated name, email or password on the verification page', async ({ page }) => {
    await page.goto(verifyUrl);
    await expect(page.getByLabel('Name')).toHaveCount(0);
    await expect(page.getByLabel('Email')).toHaveCount(0);
    await expect(page.getByLabel('Choose a password')).toHaveCount(0);
    await expect(page.getByLabel('Confirm password')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
  });

  test('a single-use email proof activates the account and starts a rotating session', async ({ page, context }) => {
    await page.goto(verifyUrl);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/loyalty\/dashboard/);
    const cookies = await context.cookies();
    const session = cookies.filter((c) => c.name.startsWith('__Host-ff_customer_'));
    expect(session.length).toBeGreaterThanOrEqual(2);
    for (const c of session) {
      expect(c.httpOnly).toBe(true);
      expect(c.secure).toBe(true);
    }
  });

  test('the same proof cannot be used again, and cannot establish a new session', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto(verifyUrl);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText(/invalid|expired|already used/i)).toBeVisible();
    expect((await context.cookies()).filter((c) => c.name.startsWith('__Host-ff_customer_'))).toHaveLength(0);
  });
});

test.describe('sign-in, refresh and logout', () => {
  test.skip(!email || password.length < 8, 'needs E2E_CUSTOMER_EMAIL and E2E_CUSTOMER_PASSWORD of a registered test customer');

  test('a wrong password gives the single generic message', async ({ page }) => {
    await signIn(page, email, `${password}-wrong`);
    await expect(page.getByText('The email or password is not correct.')).toBeVisible();
  });

  test('a registered customer signs in with email and password', async ({ page }) => {
    await signIn(page, email, password);
    await expect(page).toHaveURL(/\/loyalty\/dashboard/);
  });

  test('refresh: an expired access cookie is renewed and the customer returns to the page', async ({ page, context }) => {
    await signIn(page, email, password);
    await expect(page).toHaveURL(/\/loyalty\/dashboard/);
    const access = (await context.cookies()).find((c) => c.name === '__Host-ff_customer_access');
    expect(access, 'rotating access cookie must be set after sign-in').toBeTruthy();
    await context.clearCookies({ name: access!.name }); // simulate the 15-minute access token lapsing
    await page.goto('/loyalty/dashboard');
    await expect(page).toHaveURL(/\/loyalty\/dashboard/); // renewed via /loyalty/session/refresh, not bounced to login
  });

  test('logout ends the session: the dashboard then requires sign-in again', async ({ page }) => {
    await signIn(page, email, password);
    await expect(page).toHaveURL(/\/loyalty\/dashboard/);
    await page.getByRole('button', { name: 'Log out' }).click();
    await page.goto('/loyalty/dashboard');
    await expect(page).not.toHaveURL(/\/loyalty\/dashboard$/);
  });
});

test.describe('session revocation, rate limiting and phone attachment', () => {
  test.skip(!email || password.length < 8, 'needs E2E_CUSTOMER_EMAIL and E2E_CUSTOMER_PASSWORD of a registered test customer');

  test('after logout, the previously issued session cookies no longer authenticate', async ({ page, context }) => {
    await signIn(page, email, password);
    await expect(page).toHaveURL(/\/loyalty\/dashboard/);
    const issued = await context.cookies();
    await page.getByRole('button', { name: 'Log out' }).click();
    await context.clearCookies();
    await context.addCookies(issued); // replay what the server had issued before logout
    await page.goto('/loyalty/dashboard');
    await expect(page).not.toHaveURL(/\/loyalty\/dashboard$/);
  });

  test('repeated wrong passwords are rate limited with the generic throttle message', async ({ page }) => {
    // Uses a throwaway address, never the registered test customer, so the real account cannot be locked out.
    const throwaway = `e2e-throttle-${Date.now()}@example.test`;
    let throttled = false;
    for (let i = 0; i < 15 && !throttled; i += 1) {
      await signIn(page, throwaway, `wrong-password-${i}`);
      throttled = await page.getByText('Too many attempts. Please wait a few minutes and try again.').isVisible();
    }
    expect(throttled).toBe(true);
  });

  test('a signed-in customer can attach and verify a phone number (optional)', async ({ page }) => {
    const phone = process.env.E2E_CUSTOMER_PHONE ?? '';
    const code = process.env.E2E_CUSTOMER_PHONE_CODE ?? '';
    test.skip(!phone || !code, 'needs E2E_CUSTOMER_PHONE and E2E_CUSTOMER_PHONE_CODE (code is read from the staging Worker logs)');
    await signIn(page, email, password);
    await page.goto('/loyalty/dashboard/phone');
    await page.getByLabel('Phone number').fill(phone);
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel('Verification code').fill(code);
    await page.getByRole('button', { name: 'Verify phone' }).click();
    await expect(page.getByText('Your phone is verified')).toBeVisible();
  });
});

test.describe('legacy compatibility', () => {
  test('the email screens are a generic 404 while the flag is off (run this one against a flag-OFF stack)', async ({ page }) => {
    test.skip(process.env.E2E_EXPECT_FLAG === 'on', 'only meaningful with the flag off');
    const response = await page.goto('/loyalty/login/email');
    expect(response?.status()).toBe(404);
  });

  test('an existing legacy token for a customer without a verified email still works while the flag is on', async ({ page, context, baseURL }) => {
    test.skip(!legacyToken, 'needs E2E_LEGACY_CUSTOMER_TOKEN');
    await context.addCookies([{ name: 'ff_customer_token', value: legacyToken, url: baseURL!, httpOnly: true, secure: true }]);
    await page.goto('/loyalty/dashboard');
    await expect(page).toHaveURL(/\/loyalty\/dashboard/);
  });
});
