import { test, expect } from '@playwright/test';

/** Regression: portalled dialogs must stay readable in the dark workspace (white popup + light text was unreadable). */
test('dialogs in the dark workspace have a dark surface and readable title text', async ({
  page,
}) => {
  const unique = Date.now();
  await page.goto('/signup');
  await page.getByLabel('Full name').fill('Dialog Theme Test');
  await page.getByLabel('Email').fill(`dialog-theme-${unique}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('a-strong-test-password');
  await page.getByLabel(/I agree to the Terms of Service/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Business name').fill(`Dialog ${unique}`);
  await page.getByLabel('URL slug').fill(`dialog-theme-${unique}`);
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page.getByRole('heading', { name: 'Business Overview', exact: true })).toBeVisible();

  await page.goto('/dashboard/branches');
  await page.getByRole('button', { name: /new branch/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
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
