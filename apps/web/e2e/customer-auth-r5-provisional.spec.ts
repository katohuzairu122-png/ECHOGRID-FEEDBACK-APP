import { test, expect, type Page } from '@playwright/test';

/**
 * PROVISIONAL CUSTOMER-AUTH-R3-R5 browser contract.
 *
 * The user-provided R5 brief proposes these domains but explicitly requires
 * Owner approval before they can be treated as the canonical A-H contract.
 * This suite covers only the registration, proof, password login, rotating
 * session, safe QR return, anti-enumeration and responsive-form slices that
 * the isolated fixture can exercise without shared resources or providers.
 */
test.skip(
  process.env.CUSTOMER_AUTH_R5_TEST_ONLY !== 'true',
  'R5 customer-auth tests run only with the isolated CI mail/database fixture.',
);

const email = process.env.E2E_CUSTOMER_EMAIL ?? '';
const password = process.env.E2E_CUSTOMER_PASSWORD ?? '';
const mailboxToken = process.env.CUSTOMER_AUTH_R5_MAILBOX_TOKEN ?? '';
let verifyUrl = '';

test.describe.configure({ mode: 'serial' });

async function requestProof(page: Page, address: string, name = 'Synthetic R5 Customer') {
  await page.goto('/loyalty/signup');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(address);
  await page.getByLabel('Choose a password').fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await submitRegistration(page);
}

async function submitRegistration(page: Page) {
  await page.getByRole('button', { name: 'Send confirmation link' }).click();
}

async function expectGenericConfirmation(page: Page, previousError?: string) {
  const heading = page.getByRole('heading', { name: 'Check your email' });
  const alert = page.getByRole('alert');
  await expect
    .poll(
      async () => {
        if (await heading.isVisible()) return true;
        const messages = (await alert.allTextContents()).map((message) => message.trim());
        return messages.some((message) => message && message !== previousError);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  if (!(await heading.isVisible())) {
    const messages = (await alert.allTextContents())
      .map((message) => message.trim())
      .filter((message) => message && message !== previousError);
    throw new Error(`Registration returned a generic UI error: ${messages.join(' | ')}`);
  }
}

async function capturedVerificationLink(page: Page, address: string): Promise<string> {
  const response = await page.request.get(
    `http://127.0.0.1:8792/__test/mailbox?recipient=${encodeURIComponent(address)}`,
    { headers: { Authorization: `Bearer ${mailboxToken}` } },
  );
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as {
    messages?: Array<{ html?: string; subject?: string }>;
  };
  const message = payload.messages?.at(-1);
  expect(message?.subject).toContain('Confirm your email');
  const href = message?.html?.match(/href="([^"]+)"/)?.[1];
  expect(href).toBeTruthy();
  return href!;
}

test('A/H — customer enters account details once; registration form remains usable at mobile width', async ({
  page,
}) => {
  expect(email).toMatch(/@example\.test$/);
  expect(password.length).toBeGreaterThanOrEqual(12);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/loyalty/signup');
  await expect(page.getByLabel('Name')).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Choose a password')).toBeVisible();
  await expect(page.getByLabel('Confirm password')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByLabel('Name')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByLabel('Name').fill('Synthetic R5 Customer');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Choose a password').fill(password);
  await page.getByLabel('Confirm password').fill(`${password}-mismatch`);
  await submitRegistration(page);
  await expect(page.getByText('The passwords do not match.', { exact: true })).toBeVisible();

  await page.getByLabel('Confirm password').fill(password);
  expect((await page.getByLabel('Name').inputValue()) === 'Synthetic R5 Customer').toBe(true);
  expect((await page.getByLabel('Email').inputValue()) === email).toBe(true);
  expect((await page.getByLabel('Choose a password').inputValue()) === password).toBe(true);
  await submitRegistration(page);
    await expectGenericConfirmation(page, 'The passwords do not match.');
  } catch (error) {
    console.info('customer_auth_r5_signup_form_state', JSON.stringify(formState));
    console.info('customer_auth_r5_signup_browser_events', submissionEvents.join(' | ') || 'none');
    throw error;
  }
  expect(new URL(page.url()).searchParams.get('email')).toBeNull();
  expect(
    (await page.context().cookies()).some((cookie) =>
      cookie.name.startsWith('__Host-ff_customer_'),
    ),
  ).toBe(false);
  verifyUrl = await capturedVerificationLink(page, email);
});

test('B/G — email proof completes once, creates a rotating session, and rejects replay', async ({
  page,
  context,
}) => {
  expect(verifyUrl).toContain('/loyalty/signup/verify');
  await page.goto(verifyUrl);
  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveCount(0);
  await expect(page.getByLabel('Email')).toHaveCount(0);
  await expect(page.getByLabel('Choose a password')).toHaveCount(0);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/loyalty\/dashboard(?:\?|$)/);

  const issued = await context.cookies();
  const sessions = issued.filter((cookie) => cookie.name.startsWith('__Host-ff_customer_'));
  expect(sessions.length).toBeGreaterThanOrEqual(2);
  for (const cookie of sessions) {
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.secure).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
  }

  await context.clearCookies();
  await page.goto(verifyUrl);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(
    page.getByText(
      'This confirmation link is invalid, expired or already used. Request a new link.',
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  expect(
    (await context.cookies()).filter((cookie) => cookie.name.startsWith('__Host-ff_customer_')),
  ).toHaveLength(0);
});

test('C — password login rejects wrong credentials generically and accepts the verified account', async ({
  page,
}) => {
  await page.goto('/loyalty/login/email');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(`${password}-wrong`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByText('The email or password is not correct.', { exact: true }),
  ).toBeVisible();

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/loyalty\/dashboard(?:\?|$)/);
  expect(
    (await page.context().cookies()).some((cookie) => cookie.name === '__Host-ff_customer_access'),
  ).toBe(true);
});

test('D — refresh rotates credentials; logout revokes the issued session', async ({
  page,
  context,
}) => {
  await page.goto('/loyalty/login/email');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/loyalty\/dashboard(?:\?|$)/);

  const beforeRefresh = await context.cookies();
  const oldRefresh = beforeRefresh.find(
    (cookie) => cookie.name === '__Host-ff_customer_refresh',
  )?.value;
  expect(oldRefresh).toBeTruthy();
  await context.clearCookies({ name: '__Host-ff_customer_access' });
  await page.goto('/loyalty/session/refresh?next=%2Floyalty%2Fdashboard');
  await expect(page).toHaveURL(/\/loyalty\/dashboard(?:\?|$)/);
  const afterRefresh = await context.cookies();
  const rotatedRefresh = afterRefresh.find(
    (cookie) => cookie.name === '__Host-ff_customer_refresh',
  )?.value;
  expect(rotatedRefresh).toBeTruthy();
  expect(rotatedRefresh).not.toBe(oldRefresh);

  const issued = afterRefresh;
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/loyalty\/login/);
  await context.clearCookies();
  await context.addCookies(issued);
  await page.goto('/loyalty/session/refresh?next=%2Floyalty%2Fdashboard');
  await expect(page).toHaveURL(/\/loyalty\/login(?:\?|$)/);
});

test('F/G — QR destination survives sign-in and an external destination is sanitized', async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto('/loyalty/dashboard/qr');
  await expect(page).toHaveURL(/\/loyalty\/login\?next=/);
  expect(new URL(page.url()).searchParams.get('next')).toBe('/loyalty/dashboard/qr');

  await page.goto('/loyalty/login/email?next=%2Floyalty%2Fdashboard%2Fqr');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/loyalty\/dashboard\/qr(?:\?|$)/);

  await page.goto('/loyalty/login/email?next=https%3A%2F%2Fevil.example%2Fsteal');
  await expect(page.locator('input[name="next"]')).toHaveValue('/loyalty/dashboard');
});

test('G — duplicate and unknown registration requests use the same confirmation response', async ({
  page,
}) => {
  const unknown = `unknown-${Date.now()}@example.test`;
  await requestProof(page, email);
  await expectGenericConfirmation(page);
  const existingText = await page.getByRole('heading', { name: 'Check your email' }).textContent();
  await requestProof(page, unknown);
  await expectGenericConfirmation(page);
  const unknownText = await page.getByRole('heading', { name: 'Check your email' }).textContent();
  expect(existingText).toBe(unknownText);
});

test('G — registration delivery limit returns a generic throttle response', async ({ page }) => {
  const limited = `limited-${Date.now()}@example.test`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await requestProof(page, limited);
    await expectGenericConfirmation(page);
  }
  await requestProof(page, limited);
  await expect(
    page.getByText('Too many attempts. Please wait a few minutes and try again.', { exact: true }),
  ).toBeVisible();
});
