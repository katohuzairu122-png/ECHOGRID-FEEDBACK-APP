import { chromium, type Browser, type BrowserContext } from '@playwright/test';

/**
 * CASHIER-AUTH-02E E2-A: the real customer sign-up, driven through a browser against the staging WEB Worker.
 *
 * Implements the API harness's SignupDriver contract (apps/api/scripts/acceptance/cashier-02/provisioner.ts). The customer is created only by
 * the real pages: request the confirmation link, open it, confirm the address and choose a password, sign in. It never writes to a database
 * and never touches an API route directly. It is loaded by the harness only when the owner's three approvals are recorded; it re-checks that
 * every page it opens is on the one approved web host, over https, and never prints an address, a link, a password or a token.
 *
 * STATUS: written against the pages the existing customer email-auth acceptance spec drives. It has NOT been exercised against a live staging
 * stack, because that needs the approved test mailbox and approvals that are not recorded. It is unit-wired through a fake only.
 */
export interface SignupDriver {
  requestSignup(email: string): Promise<void>;
  completeSignup(verifyUrl: string, email: string, password: string): Promise<void>;
  signIn(email: string, password: string): Promise<{ customerId: string; accessToken: string }>;
}

export function createSignupDriver(opts: { webHost: string }): SignupDriver & { close(): Promise<void> } {
  if (!/^[a-z0-9.-]+$/.test(opts.webHost) || !/-staging(\.|$)/.test(opts.webHost.split('.')[0] + '.')) {
    throw new Error('the sign-up driver only accepts a staging web host');
  }
  const base = `https://${opts.webHost}`;
  let browser: Browser | null = null;
  const contexts: BrowserContext[] = [];

  const open = async (): Promise<BrowserContext> => {
    browser ??= await chromium.launch({
      ...(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH, args: ['--no-sandbox'] } : {}),
    });
    const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
    await context.addCookies([{ name: 'ff_locale', value: 'en', url: base }]);
    contexts.push(context);
    return context;
  };

  const assertOnWeb = (raw: string, path?: string) => {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== opts.webHost || url.port !== '' || url.username !== '' || url.password !== '') {
      throw new Error('refusing to open a page outside the approved staging web host');
    }
    if (path && url.pathname !== path) throw new Error('refusing to open an unexpected page');
  };

  return {
    async requestSignup(email) {
      const context = await open();
      const page = await context.newPage();
      await page.goto(`${base}/loyalty/signup`);
      await page.getByLabel('Email').fill(email);
      await page.getByRole('button', { name: 'Send confirmation link' }).click();
      await page.getByText('Check your email').waitFor({ timeout: 30_000 });
      await context.close();
    },
    async completeSignup(verifyUrl, email, password) {
      assertOnWeb(verifyUrl, '/loyalty/signup/verify');
      const context = await open();
      const page = await context.newPage();
      await page.goto(verifyUrl);
      await page.getByLabel('Confirm your email').fill(email);
      await page.getByLabel('Choose a password').fill(password);
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.waitForURL(/\/loyalty\/dashboard/, { timeout: 30_000 });
      await context.close();
    },
    async signIn(email, password) {
      const context = await open();
      const page = await context.newPage();
      await page.goto(`${base}/loyalty/login/email`);
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(/\/loyalty\/dashboard/, { timeout: 30_000 });
      const access = (await context.cookies()).find((c) => c.name === '__Host-ff_customer_access');
      if (!access) throw new Error('no customer session was issued');
      const claims = JSON.parse(Buffer.from(access.value.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: unknown };
      if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw new Error('the session has no customer identity');
      await context.close();
      return { customerId: claims.sub, accessToken: access.value };
    },
    async close() {
      for (const c of contexts) await c.close().catch(() => undefined);
      await browser?.close();
    },
  };
}
