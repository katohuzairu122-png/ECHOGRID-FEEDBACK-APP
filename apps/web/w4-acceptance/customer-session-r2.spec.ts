import { expect, test } from '@playwright/test';

const path = '/api/customer-auth/r2-fixture';
const access = '__Host-ff_customer_access';
const refresh = '__Host-ff_customer_refresh';

test.use({ trace: 'off', screenshot: 'off' });

test('rotating customer session traverses Web, API and disposable PostgreSQL', async ({ page, context }) => {
  test.skip(process.env.CI !== 'true', 'Fixture runs only in disposable CI');
  await page.goto('/');
  const post = (operation: string) => page.evaluate(async (url) => {
    const response = await fetch(url, { method: 'POST' });
    return response.status;
  }, `${path}?operation=${operation}`);
  const read = () => page.evaluate(async (url) => {
    const response = await fetch(url, { cache: 'no-store' });
    return { status: response.status, locale: response.ok ? (await response.json()).data.locale : null };
  }, path);

  expect((await context.request.post(`${path}?operation=login`, {
    headers: { Origin: 'https://different.example.test' },
  })).status()).toBe(403);
  expect(await read()).toEqual({ status: 401, locale: null });
  expect(await post('login')).toBe(204);
  const findCookie = async (name: string) => (await context.cookies()).find((cookie) => cookie.name === name);
  for (const name of [access, refresh]) {
    const cookie = await findCookie(name);
    expect(cookie && {
      secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, path: cookie.path,
    }).toEqual({ secure: true, httpOnly: true, sameSite: 'Lax', path: '/' });
  }
  expect(await page.evaluate(() => document.cookie.includes('__Host-ff_customer_'))).toBe(false);
  expect(await read()).toEqual({ status: 200, locale: 'ar' });

  const previousRefresh = (await findCookie(refresh))?.value;
  await expect.poll(async () => (await read()).status, { timeout: 17_000 }).toBe(401);
  expect(await post('refresh')).toBe(204);
  expect((await findCookie(refresh))?.value !== previousRefresh).toBe(true);
  expect(await read()).toEqual({ status: 200, locale: 'ar' });
  const previousAccess = (await findCookie(access))?.value;
  const priorRefresh = (await findCookie(refresh))?.value;
  expect(await post('logout')).toBe(204);
  expect(await findCookie(access)).toBeUndefined();
  expect(await findCookie(refresh)).toBeUndefined();
  expect(await read()).toEqual({ status: 401, locale: null });

  if (!previousAccess || !priorRefresh) throw new Error('Missing synthetic credentials');
  await context.addCookies([
    { name: access, value: previousAccess, url: 'http://localhost:3000', secure: true, httpOnly: true },
    { name: refresh, value: priorRefresh, url: 'http://localhost:3000', secure: true, httpOnly: true },
  ]);
  expect(await read()).toEqual({ status: 401, locale: null });
  expect(await post('refresh')).toBe(401);
});
