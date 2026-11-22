import { test, expect } from '@playwright/test';

/**
 * CUSTOMER-AUTH-UX-02-R3 isolated acceptance: preserve a requested QR
 * destination across an ordinary email/password login.
 *
 * This deliberately does NOT claim business-specific QR enrollment, consent,
 * tenant membership, phone attachment or legacy upgrade coverage.
 *
 * Never execute against staging/production: a test-specific opt-in is required,
 * and the browser baseURL must resolve to a loopback hostname.
 */
test('password return login preserves the requested QR destination on an isolated stack', async ({
  page, context, baseURL,
}) => {
  test.skip(process.env.E2E_CUSTOMER_AUTH_ISOLATED !== '1',
    'Requires explicit isolated customer-auth acceptance opt-in');
  const email = process.env.E2E_CUSTOMER_EMAIL ?? '';
  const password = process.env.E2E_CUSTOMER_PASSWORD ?? '';
  test.skip(!email.endsWith('@example.test') || password.length < 8,
    'Requires a disposable synthetic @example.test customer and password');
  const origin = baseURL ? new URL(baseURL) : null;
  test.skip(!origin || !['localhost', '127.0.0.1'].includes(origin.hostname),
    'Refuses non-loopback (staging and production) browser targets');

  await context.clearCookies();
  const destination = '/loyalty/dashboard/qr';
  await page.goto(`/loyalty/login/email?next=${encodeURIComponent(destination)}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`/loyalty/dashboard/qr(?:\\?|$)`));
  const cookies = await context.cookies();
  expect(cookies.some((cookie) =>
    cookie.name === '__Host-ff_customer_access' && cookie.httpOnly && cookie.secure)).toBe(true);
});


test('email login rejects an external return destination before credentials are submitted', async ({
  page, baseURL,
}) => {
  test.skip(process.env.E2E_CUSTOMER_AUTH_ISOLATED !== '1',
    'Requires explicit isolated customer-auth acceptance opt-in');
  const origin = baseURL ? new URL(baseURL) : null;
  test.skip(!origin || !['localhost', '127.0.0.1'].includes(origin.hostname),
    'Refuses non-loopback browser targets');

  await page.goto('/loyalty/login/email?next=https%3A%2F%2Fevil.example%2Fsteal');
  const next = await page.locator('input[name="next"]').inputValue();
  expect(next).toBe('/loyalty/dashboard');
  expect(new URL(next, origin!).origin).toBe(origin!.origin);
});


test('unknown email and incorrect password receive the same generic response and no customer session', async ({
  page, context, baseURL,
}) => {
  test.skip(process.env.E2E_CUSTOMER_AUTH_ISOLATED !== '1',
    'Requires explicit isolated customer-auth acceptance opt-in');
  const origin = baseURL ? new URL(baseURL) : null;
  test.skip(!origin || !['localhost', '127.0.0.1'].includes(origin.hostname),
    'Refuses non-loopback browser targets');
  const existingEmail = process.env.E2E_CUSTOMER_EMAIL ?? '';
  test.skip(!existingEmail.endsWith('@example.test'),
    'Requires a synthetic existing customer to test wrong password without guessing identities');

  const errorText = 'The email or password is not correct.';
  const attempts = [
    { email: `missing-${crypto.randomUUID()}@example.test`, password: 'incorrect-password-synthetic' },
    { email: existingEmail, password: `incorrect-${crypto.randomUUID()}` },
  ];
  for (const attempt of attempts) {
    await context.clearCookies();
    await page.goto('/loyalty/login/email');
    await page.getByLabel('Email').fill(attempt.email);
    await page.getByLabel('Password').fill(attempt.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(errorText)).toBeVisible();
    const cookies = await context.cookies();
    expect(cookies.filter(cookie => cookie.name.startsWith('__Host-ff_customer_'))).toHaveLength(0);
  }
});
