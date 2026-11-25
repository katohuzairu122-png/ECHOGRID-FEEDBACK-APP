import { test, expect } from '@playwright/test';
import { signUpBusinessOwner } from './helpers/signup';

/** Regression: portalled dialogs must stay readable in the dark workspace (white popup + light text was unreadable). */
test('dialogs in the dark workspace have a dark surface and readable title text', async ({
  page,
}) => {
  const unique = Date.now();
  await signUpBusinessOwner(page, { fullName: 'Dialog Theme Test', email: `dialog-theme-${unique}@example.test`, password: 'a-strong-test-password' });
  await page.getByLabel('Business name').fill(`Dialog ${unique}`);
  await page.getByRole('button', { name: 'Create business' }).click();
  // BCOMM-01: a new owner lands on the Community hub; these specs exercise the Business Overview, which keeps its own destination.
  await expect(page.getByRole('heading', { name: 'Community', exact: true })).toBeVisible();
  await page.goto('/dashboard/overview');
  await expect(page.getByRole('heading', { name: 'Business Overview', exact: true })).toBeVisible();

  // Diagnostics: when the dialog does not open, the log shows why (page errors, console errors, visible text).
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/eval\(\)/.test(m.text())) problems.push(`console: ${m.text().slice(0, 300)}`);
  });
  await page.goto('/dashboard/branches');
  const dialog = page.getByRole('dialog');
  try {
    // The button is server-rendered before the page's JavaScript has hydrated, and a click before hydration does
    // nothing. Retry the click until the dialog appears instead of assuming hydration finished.
    await expect(async () => {
      await page.getByRole('button', { name: /new branch/i }).click();
      await expect(dialog).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 20_000 });
  } catch (error) {
    const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 800).replace(/\n/g, ' | ');
    console.error(`[dialog-theme diagnostics] url=${page.url()} problems=${JSON.stringify(problems)} body=${text}`);
    throw error;
  }
  const ratio = await dialog.evaluate((el) => {
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    const title = el.querySelector('h2, [data-title], h1') as HTMLElement;
    const bg = lum(parse(getComputedStyle(el).backgroundColor));
    const fg = lum(parse(getComputedStyle(title).color));
    return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});
