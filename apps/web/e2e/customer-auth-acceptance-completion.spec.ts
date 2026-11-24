import { test, expect, type Page, type BrowserContext } from '@playwright/test';

// Synthetic identities only. The configuration and API fixture independently
// refuse shared databases, non-loopback hosts and absent CI/test-only guards.
test.skip(process.env.CUSTOMER_AUTH_R5_TEST_ONLY !== 'true', 'Disposable acceptance fixture only');
test.describe.configure({ mode: 'serial' });
const api = 'http://127.0.0.1:8792';
const fixtureHeaders = { Authorization: `Bearer ${process.env.CUSTOMER_AUTH_R5_MAILBOX_TOKEN ?? ''}` };
const baseEmail = process.env.E2E_CUSTOMER_EMAIL ?? '';
const email = baseEmail.replace('@', '-completion@');
const password = process.env.E2E_CUSTOMER_PASSWORD ?? '';

async function helper(page: Page, path: string, data: unknown = {}) {
  const r = await page.request.post(api + '/__test/' + path, { headers: fixtureHeaders, data });
  expect(r.ok()).toBe(true); return r;
}
async function mailLink(page: Page, recipient: string, path: string) {
  const r = await page.request.get(api + '/__test/mailbox?recipient=' + encodeURIComponent(recipient), { headers: fixtureHeaders });
  expect(r.status()).toBe(200);
  const messages = (await r.json()).messages as Array<{ html: string }>;
  const message = [...messages].reverse().find(m => m.html.includes(path));
  const href = message?.html.match(/href="([^"]+)"/)?.[1];
  expect(Boolean(href)).toBe(true); return href!.replaceAll('&amp;', '&');
}
async function login(page: Page, recipient = email) {
  await page.goto('/loyalty/login/email');
  await page.getByLabel('Email', { exact: true }).fill(recipient);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/loyalty\/dashboard(?:\?|$)/);
}
async function bearer(context: BrowserContext) {
  const value = (await context.cookies()).find(c => c.name === '__Host-ff_customer_access')?.value;
  expect(Boolean(value)).toBe(true); return { Authorization: `Bearer ${value}` };
}
async function effects(page: Page) {
  const r = await page.request.get(api + '/__test/customer-effects?recipient=' + encodeURIComponent(email), { headers: fixtureHeaders });
  expect(r.status()).toBe(200); return r.json();
}
async function register(page: Page, recipient: string) {
  await page.goto('/loyalty/signup');
  await page.getByLabel('Name', { exact: true }).fill('Synthetic completion customer');
  await page.getByLabel('Email', { exact: true }).fill(recipient);
  await page.getByLabel('Choose a password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Send confirmation link', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email', exact: true })).toBeVisible();
  return mailLink(page, recipient, '/loyalty/signup/verify');
}
test.beforeEach(async ({ page }) => { await helper(page, 'reset-acceptance-budgets'); });

test('A/B — expired email proof cannot activate an identity; fresh proof creates the independent acceptance account', async ({ page, context }) => {
  const expiredEmail = baseEmail.replace('@', '-expired@');
  const proof = await register(page, expiredEmail);
  await helper(page, 'acceptance-clock', { recipient: expiredEmail, kind: 'registration' });
  await page.goto(proof);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByText('This confirmation link is invalid, expired or already used. Request a new link.', { exact: true })).toBeVisible();
  expect((await context.cookies()).filter(c => c.name.includes('customer_access'))).toHaveLength(0);
  const fresh = await register(page, email);
  await page.goto(fresh);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/loyalty\/dashboard(?:\?|$)/);
});

test('F/G — signed branch QR preserves login context, requires explicit consent and isolates the two businesses', async ({ page, context }) => {
  const qr = await (await helper(page, 'seed-qr-context')).json();
  const anonymous = await page.goto('/feedback/' + qr.a.token);
  expect(anonymous?.status()).toBe(200);
  const before = await effects(page);
  expect(before).toMatchObject({ memberships: 0, consents: 0, onboarding: 0, points: 0, transactions: 0, community: 0 });
  await page.getByRole('link', { name: 'Sign in for eligible loyalty actions', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/feedback/'));
  expect(new URL(page.url()).pathname === '/feedback/' + qr.a.token).toBe(true);
  const headers = await bearer(context);
  const join = page.getByRole('button', { name: 'Join loyalty', exact: true });
  await expect(join).toBeDisabled();
  expect(await effects(page)).toEqual(before);
  const missingConsent = await page.request.post(api + '/api/v1/customer-memberships/join', { headers, data: { qrToken: qr.a.token, consentVersion: 'v1', consentAccepted: false } });
  expect(missingConsent.status()).toBe(400);
  for (const token of [qr.expired, qr.foreignScope, qr.a.token.slice(0, -3) + 'xxx']) {
    const denied = await page.request.post(api + '/api/v1/customer-memberships/join', { headers, data: { qrToken: token, consentAccepted: true, consentVersion: 'v1' } });
    expect(denied.status()).toBe(404);
  }
  expect(await effects(page)).toEqual(before);
  await page.getByRole('checkbox').check(); await join.click();
  await expect(page.getByRole('link', { name: 'My loyalty account', exact: true })).toBeVisible();
  const after = await effects(page);
  expect(after).toMatchObject({ memberships: 1, consents: 1, onboarding: 1, points: 0, transactions: 0, community: 0 });
  const duplicate = await page.request.post(api + '/api/v1/customer-memberships/join', { headers, data: { qrToken: qr.legacy, consentAccepted: true, consentVersion: 'v1' } });
  expect(duplicate.status()).toBe(201); expect(await effects(page)).toEqual(after);
  const other = await page.request.get(api + '/api/v1/loyalty/me/accounts/' + qr.b.businessId, { headers });
  expect(other.status()).toBe(404);
  await helper(page, 'revoke-qr', { qrId: qr.b.qrId });
  const revoked = await page.request.post(api + '/api/v1/customer-memberships/join', { headers, data: { qrToken: qr.b.token, consentAccepted: true, consentVersion: 'v1' } });
  expect(revoked.status()).toBe(404); expect(await effects(page)).toEqual(after);
});

test('G — a second customer cannot read or mutate the first customer’s real membership/account through identifiers or tenant headers', async ({ page, context, browser }) => {
  await login(page); const victim = await effects(page); const victimHeaders = await bearer(context);
  const memberships = await (await page.request.get(api + '/api/v1/customer-memberships', { headers: victimHeaders })).json();
  const businessId = memberships.data[0].businessId;
  const attackerEmail = baseEmail.replace('@', '-attacker@');
  const other = await browser.newContext();
  try {
    const attacker = await other.newPage(); const proof = await register(attacker, attackerEmail);
    await attacker.goto(proof); await attacker.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(attacker).toHaveURL(/\/loyalty\/dashboard(?:\?|$)/);
    const headers = { ...await bearer(other), 'X-Business-Id': businessId };
    for (const path of ['/loyalty/me/accounts/' + businessId, '/customer-memberships/' + businessId]) {
      expect((await attacker.request.get(api + '/api/v1' + path, { headers })).status()).toBe(404);
    }
    const own = await attacker.request.get(api + '/api/v1/loyalty/me/accounts?customerId=' + victim.id, { headers });
    expect((await own.json()).data).toEqual([]);
    const leave = await attacker.request.post(api + '/api/v1/customer-memberships/' + businessId + '/leave', { headers, data: { customerId: victim.id } });
    expect(leave.status()).toBe(404);
    const noSession = await page.request.get(api + '/api/v1/customer-memberships/' + businessId);
    expect(noSession.status()).toBe(401);
    expect(await effects(page)).toEqual(victim);
  } finally { await other.close(); }
});

test('G — direct callers cannot forge the Web attribution or use a customer session as a staff credential', async ({ page, context }) => {
  await login(page); const before = await effects(page);
  for (const [path, data] of [
    ['/customer-auth/email/login', { email, password }],
    ['/customer-recovery/initiate', { email }],
  ] as const) {
    const response = await page.request.post(api + '/api/v1' + path, {
      headers: { 'cf-connecting-ip': '198.51.100.77', 'X-Business-Id': before.id }, data,
    });
    expect(response.status()).toBe(503);
    expect(response.headers()['set-cookie']).toBeUndefined();
  }
  const staff = await page.request.get(api + '/api/v1/businesses', { headers: await bearer(context) });
  expect(staff.status()).toBe(401);
  expect(await effects(page)).toEqual(before);
});

test('D — expired access refreshes through the real BFF; idle, absolute and refresh expiry deny protected access', async ({ page, context }) => {
  await login(page);
  const expired = await (await helper(page, 'acceptance-clock', { recipient: email, kind: 'access' })).json();
  const cookie = (await context.cookies()).find(c => c.name === '__Host-ff_customer_access')!;
  await context.addCookies([{ ...cookie, value: expired.accessToken }]);
  await page.goto('/loyalty/dashboard/settings');
  await expect(page).toHaveURL(/\/loyalty\/dashboard\/settings(?:\?|$)/);
  expect((await page.request.get(api + '/api/v1/loyalty/me/profile', { headers: await bearer(context) })).status()).toBe(200);
  for (const kind of ['idle', 'absolute', 'refresh']) {
    await context.clearCookies(); await login(page);
    await helper(page, 'acceptance-clock', { recipient: email, kind });
    await context.clearCookies({ name: '__Host-ff_customer_access' });
    await page.goto('/loyalty/session/refresh?next=%2Floyalty%2Fdashboard');
    await expect(page).toHaveURL(/\/loyalty\/login(?:\?|$)/);
    expect((await context.cookies()).filter(c => c.name === '__Host-ff_customer_refresh')).toHaveLength(0);
  }
});

test('D — concurrent refresh has one winner, stale replay revokes that session and preserves a separate device', async ({ page, context, browser }) => {
  await login(page); const original = await context.cookies();
  const clones = await Promise.all([browser.newContext(), browser.newContext()]);
  const independent = await browser.newContext();
  try {
    for (const clone of clones) await clone.addCookies(original);
    const results = await Promise.all(clones.map(c => c.request.get('http://localhost:3000/loyalty/session/refresh?next=%2Floyalty%2Fdashboard', { maxRedirects: 0 })));
    for (const result of results) expect(result.status()).toBe(303);
    const changed = await Promise.all(clones.map(async c => {
      const before = original.find(v => v.name === '__Host-ff_customer_refresh')?.value;
      const after = (await c.cookies()).find(v => v.name === '__Host-ff_customer_refresh')?.value;
      return before !== after;
    }));
    expect(changed.filter(Boolean)).toHaveLength(1);
    const winner = clones[changed.indexOf(true)]!;
    const independentPage = await independent.newPage(); await login(independentPage);
    await helper(page, 'acceptance-clock', { recipient: email, kind: 'replay' });
    await context.clearCookies(); await context.addCookies(original);
    await page.goto('/loyalty/session/refresh?next=%2Floyalty%2Fdashboard');
    await expect(page).toHaveURL(/\/loyalty\/login(?:\?|$)/);
    expect((await page.request.get(api + '/api/v1/loyalty/me/profile', { headers: await bearer(winner) })).status()).toBe(401);
    expect((await page.request.get(api + '/api/v1/loyalty/me/profile', { headers: await bearer(independent) })).status()).toBe(200);
  } finally { for (const clone of clones) await clone.close(); await independent.close(); }
});

async function startEmailRecovery(page: Page) {
  await page.goto('/account/recovery');
  await page.getByLabel('Account email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Send email confirmation', exact: true }).click();
  await expect(page.getByText('If the recovery can continue, an email will arrive with a secure link.', { exact: true })).toBeVisible();
  await page.goto(await mailLink(page, email, '/account/recovery/email#c='));
  await page.getByRole('button', { name: 'Confirm this email factor', exact: true }).click();
  await expect(page.getByText('One more independent factor is required before a password can be reset.', { exact: true })).toBeVisible();
}

test('E — Settings reauthentication, one-time codes, cancellation and consumed-code replay use the real recovery routes', async ({ page, context }) => {
  await login(page); await page.goto('/loyalty/dashboard/settings');
  const issue = page.locator('form').filter({ has: page.getByRole('button', { name: 'Create a new recovery-code set', exact: true }) });
  await issue.getByLabel('Confirm your current password', { exact: true }).fill('not-the-password');
  await issue.getByRole('button', { name: 'Create a new recovery-code set', exact: true }).click();
  await expect(issue.getByRole('alert')).toBeVisible();
  await issue.getByLabel('Confirm your current password', { exact: true }).fill(password);
  await issue.getByRole('button', { name: 'Create a new recovery-code set', exact: true }).click();
  // The section is an aria-live announcement, not an extra named region.
  const codes = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Save your recovery codes', exact: true }) }).locator('li');
  await expect(codes).toHaveCount(8); const first = await codes.first().innerText();
  expect(/^(?:[0-9A-Z]{4}-){6}[0-9A-Z]{4}$/.test(first)).toBe(true);
  await context.clearCookies();
  await startEmailRecovery(page);
  await page.getByLabel('One unused recovery code', { exact: true }).fill(first);
  await page.getByRole('button', { name: 'Verify recovery code', exact: true }).click();
  await expect(page.getByText('For your security, this recovery is on hold until', { exact: false })).toBeVisible();
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  expect((await context.cookies()).filter(c => c.name.includes('customer_access'))).toHaveLength(0);
  const cancellation = await mailLink(page, email, '/account/recovery/cancel#c=');
  await page.goto(cancellation);
  await page.getByRole('button', { name: 'Cancel recovery', exact: true }).click();
  await expect(page.getByText('Recovery cancelled. Your password was not changed.', { exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/#c=/);
  await page.goto(cancellation);
  await page.getByRole('button', { name: 'Cancel recovery', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await startEmailRecovery(page);
  await page.getByLabel('One unused recovery code', { exact: true }).fill(first);
  await page.getByRole('button', { name: 'Verify recovery code', exact: true }).click();
  await expect(page.getByText('This recovery request is invalid, expired or already used.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  // Cancel the fresh attempt before the next journey, without restoring its spent code.
  await page.goto(await mailLink(page, email, '/account/recovery/cancel#c='));
  await page.getByRole('button', { name: 'Cancel recovery', exact: true }).click();
  await expect(page.getByRole('status')).toBeVisible();
  await login(page); await page.goto('/loyalty/dashboard/settings');
  const revoke = page.locator('form').filter({ has: page.getByRole('button', { name: 'Revoke recovery codes', exact: true }) });
  await revoke.getByLabel('Confirm your current password', { exact: true }).fill(password);
  await revoke.getByRole('button', { name: 'Revoke recovery codes', exact: true }).click();
  await expect(page.getByText('Recovery codes revoked.', { exact: true })).toBeVisible();
});

test('H — customer routes expose labels, keyboard actions and responsive landmarks in all supported languages', async ({ page, context }) => {
  for (const locale of ['en', 'fr', 'es', 'ar']) {
    await context.clearCookies();
    await context.addCookies([{ name: 'ff_locale', value: locale, url: 'http://localhost:3000' }]);
    for (const route of ['/loyalty/signup', '/loyalty/login/email', '/account/recovery']) {
      await page.setViewportSize({ width: 360, height: 900 });
      expect((await page.goto(route))?.status()).toBe(200);
      await expect(page.locator('main')).toHaveCount(1);
      const tree = await page.locator('main').ariaSnapshot();
      expect(tree.includes('heading')).toBe(true); expect(tree.includes('textbox')).toBe(true);
      const inputs = page.locator('input:not([type="hidden"])');
      expect(await inputs.count()).toBeGreaterThan(0);
      for (const input of await inputs.all()) {
        expect(await input.evaluate(el => (el as HTMLInputElement).labels?.length ?? 0)).toBeGreaterThan(0);
      }
      for (const width of [360, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      const first = inputs.first(); await first.focus(); await expect(first).toBeFocused();
      await page.keyboard.press('Tab'); expect(await first.evaluate(el => document.activeElement !== el)).toBe(true);
      expect(await page.locator('html').getAttribute('dir')).toBe(locale === 'ar' ? 'rtl' : 'ltr');
    }
  }
});

test('E — lost-email recovery requires both verified phone and an unused code and cannot skip the security hold', async ({ page, context }) => {
  await login(page);
  const phone = (await (await helper(page, 'mark-phone-verified', { recipient: email })).json()).phone as string;
  expect(/^\+[1-9][0-9]+$/.test(phone)).toBe(true);
  await page.goto('/loyalty/dashboard/settings');
  const issue = page.locator('form').filter({ has: page.getByRole('button', { name: 'Create a new recovery-code set', exact: true }) });
  await issue.getByLabel('Confirm your current password', { exact: true }).fill(password);
  await issue.getByRole('button', { name: 'Create a new recovery-code set', exact: true }).click();
  const codes = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Save your recovery codes', exact: true }) }).locator('li');
  await expect(codes).toHaveCount(8); const code = await codes.first().innerText();
  await context.clearCookies(); await page.goto('/account/recovery');
  await page.getByRole('button', { name: 'Verified phone', exact: true }).click();
  await page.getByLabel('Verified phone number', { exact: true }).fill(phone);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Send phone code', exact: true }).click();
  await page.getByLabel('Phone verification code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Verify phone code', exact: true }).click();
  await expect(page.getByText('One more independent factor is required before a password can be reset.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  await page.getByLabel('One unused recovery code', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Verify recovery code', exact: true }).click();
  await expect(page.getByText('For your security, this recovery is on hold until', { exact: false })).toBeVisible();
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  expect((await context.cookies()).filter(c => c.name.includes('customer_access'))).toHaveLength(0);
  await page.goto(await mailLink(page, email, '/account/recovery/cancel#c='));
  await page.getByRole('button', { name: 'Cancel recovery', exact: true }).click();
  await expect(page.getByRole('status')).toBeVisible();
});

test('H — Settings, phone verification and invalid proof/cancellation landings remain accessible across languages and widths', async ({ page, context }) => {
  await login(page);
  for (const locale of ['en', 'fr', 'es', 'ar']) {
    await context.addCookies([{ name: 'ff_locale', value: locale, url: 'http://localhost:3000' }]);
    for (const route of ['/loyalty/dashboard/settings', '/loyalty/dashboard/phone', '/loyalty/signup/verify#c=forged', '/account/recovery/email#c=forged', '/account/recovery/cancel#c=forged']) {
      expect((await page.goto(route))?.status()).toBe(200);
      await expect(page.locator('main')).toHaveCount(1);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      for (const width of [360, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      for (const input of await page.locator('input:not([type="hidden"])').all()) {
        expect(await input.evaluate(el => (el as HTMLInputElement).labels?.length ?? 0)).toBeGreaterThan(0);
      }
    }
  }
});
