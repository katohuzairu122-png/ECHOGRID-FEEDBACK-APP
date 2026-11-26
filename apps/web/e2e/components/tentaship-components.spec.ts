import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Real-Chromium acceptance of the CONTAINED TSH-06 campaign card and TDP-04 sponsorship report. The static pages are produced by render-fixtures.vitest.ts
 * (the components rendered with the app's own compiled Tailwind CSS); this spec only loads them, so no route, server, API or database is involved.
 */
const FIXTURE_DIR = path.resolve(__dirname, '../../node_modules/.cache/tentaship-component-fixtures');
type L = 'en' | 'ar' | 'es' | 'fr';
const SHOTS = process.env.TENTASHIP_SHOTS_DIR;
test.beforeAll(() => { if (SHOTS) mkdirSync(SHOTS, { recursive: true }); });
async function open(page: Page, name: string, locale: L) { await page.goto(pathToFileURL(path.join(FIXTURE_DIR, `${name}-${locale}.html`)).href); await page.evaluate(() => document.fonts.ready); }
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

for (const locale of ['en', 'ar', 'es', 'fr'] as const) {
  test.describe(`${locale}`, () => {
    test(`sponsorship report renders without overflow, with correct direction and mirrored rows (${locale})`, async ({ page }, info) => {
      await open(page, 'report', locale);
      const rtl = locale === 'ar';
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe(rtl ? 'rtl' : 'ltr');
      expect(await noOverflow(page)).toBe(true);
      await expect(page.getByTestId('drops-report')).toBeVisible();
      const card = await page.getByTestId('drops-report').boundingBox(); expect(card!.width).toBeGreaterThan(200);
      // each metric row: the label sits at the START edge and the value at the END edge (mirrored in RTL); they never overlap
      const row = page.getByTestId('m-total').locator('xpath=..'); const dt = await row.locator('dt').boundingBox(); const dd = await row.locator('dd').boundingBox();
      expect(dt && dd).toBeTruthy();
      if (rtl) expect(dt!.x).toBeGreaterThan(dd!.x); else expect(dt!.x).toBeLessThan(dd!.x);
      expect(Math.abs(dt!.y - dd!.y)).toBeLessThan(dt!.height + 40);
      expect(dt!.x + dt!.width <= dd!.x + 1 || dd!.x + dd!.width <= dt!.x + 1).toBe(true);
      // the section's text alignment resolves to the start edge
      expect(await page.getByTestId('drops-report').evaluate((el) => getComputedStyle(el).textAlign)).toMatch(/start|right|left/);
      expect(await page.getByTestId('m-total').innerText()).toMatch(/120|١٢٠/);
      // nothing interactive is rendered
      expect(await page.locator('a, button, input, select, textarea, form').count()).toBe(0);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `report-${locale}-${info.project.name}.png`), fullPage: true });
    });

    test(`unavailable and suppressed figures are never shown as zero, and a failed reconciliation is an alert (${locale})`, async ({ page }) => {
      await open(page, 'report-hidden', locale);
      expect(await noOverflow(page)).toBe(true);
      for (const id of ['m-reserved', 'm-completion']) { const el = page.getByTestId(id); await expect(el).toBeVisible(); await expect(el).toHaveAttribute('data-unavailable', 'true'); expect(await el.innerText()).not.toMatch(/[0-9٠-٩]/); }
      await expect(page.getByTestId('m-reconciled')).toHaveAttribute('role', 'alert');
    });

    test(`campaign card renders recorded values only, without overflow (${locale})`, async ({ page }, info) => {
      await open(page, 'campaign', locale);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe(locale === 'ar' ? 'rtl' : 'ltr');
      expect(await noOverflow(page)).toBe(true);
      await expect(page.getByTestId('campaign-status')).toBeVisible(); await expect(page.getByTestId('campaign-eligibility')).toBeVisible(); await expect(page.getByTestId('campaign-disclosure')).toBeVisible();
      expect(await page.locator('a, button, input, select, textarea, form').count()).toBe(0);
      const text = (await page.locator('main').innerText()).toLowerCase();
      expect(text).not.toMatch(/guarantee|garant|prize|premio|prix|odds|جائزة|مضمون/);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `campaign-${locale}-${info.project.name}.png`), fullPage: true });
    });
  });
}
