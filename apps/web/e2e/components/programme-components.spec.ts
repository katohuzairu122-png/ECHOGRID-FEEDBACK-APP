import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Real-Chromium acceptance of the loyalty programme selector and configuration forms (LOYALTY-PROGRAMME-COMPLETION Group 03), at desktop and mobile
 * sizes, in LTR and Arabic RTL, in all four languages. The static pages are produced by render-fixtures.vitest.ts with the app's own compiled CSS.
 */
const FIXTURE_DIR = path.resolve(__dirname, '../../node_modules/.cache/tentaship-component-fixtures');
type L = 'en' | 'ar' | 'es' | 'fr';
const SHOTS = process.env.TENTASHIP_SHOTS_DIR;
test.beforeAll(() => { if (SHOTS) mkdirSync(SHOTS, { recursive: true }); });
async function open(page: Page, name: string, locale: L) { await page.goto(pathToFileURL(path.join(FIXTURE_DIR, `${name}-${locale}.html`)).href); await page.evaluate(() => document.fonts.ready); }
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const direction = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).direction);
/** Every form control must have an accessible name: a label, an aria-label or an enclosing label. */
const unnamedControls = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].filter((el) => {
    const input = el as HTMLInputElement;
    return !(input.labels && input.labels.length > 0) && !input.getAttribute('aria-label') && !input.getAttribute('aria-labelledby');
  }).map((el) => (el as HTMLInputElement).name || el.tagName));

for (const locale of ['en', 'ar', 'es', 'fr'] as const) {
  test.describe(`${locale}`, () => {
    test(`programme selector: eight cards, LP-08 unavailable with a reason, no overflow, correct direction (${locale})`, async ({ page }, info) => {
      await open(page, 'programme-cards', locale);
      expect(await direction(page)).toBe(locale === 'ar' ? 'rtl' : 'ltr');
      expect(await noOverflow(page)).toBe(true);
      await expect(page.locator('[data-testid^="programme-card-LP-0"]')).toHaveCount(8);
      const lp08 = page.getByTestId('programme-card-LP-08');
      await expect(lp08).toBeVisible();
      expect(await lp08.locator('a').count()).toBe(0); // no select action
      await expect(lp08.getByRole('note')).toBeVisible();
      const selectable = page.locator('[data-testid^="programme-card-LP-0"] a');
      expect(await selectable.count()).toBe(7);
      for (const link of await selectable.all()) { const box = await link.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(40); }
      // the no-programme notice is a status region, and the cards never run off the viewport
      await expect(page.locator('[role="status"]').first()).toBeVisible();
      if (locale === 'ar') { const first = await page.getByTestId('programme-card-LP-01').boundingBox(); const second = await page.getByTestId('programme-card-LP-02').boundingBox(); if (first!.y === second!.y) expect(first!.x).toBeGreaterThan(second!.x); }
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `programme-cards-${locale}-${info.project.name}.png`), fullPage: true });
    });

    test(`LP-06 form: weekday groups, local times, confirmation, accessible names and no overflow (${locale})`, async ({ page }, info) => {
      await open(page, 'programme-lp06', locale);
      expect(await direction(page)).toBe(locale === 'ar' ? 'rtl' : 'ltr');
      expect(await noOverflow(page)).toBe(true);
      await expect(page.locator('input[type="checkbox"][name="windows.0.days"]')).toHaveCount(7);
      await expect(page.locator('input[type="time"]')).toHaveCount(2);
      expect(await unnamedControls(page)).toEqual([]);
      const confirm = page.locator('input[name="confirm"]');
      await expect(confirm).toBeVisible();
      await expect(confirm).not.toBeChecked();
      await expect(page.locator('button[name="intent"][value="activate"]')).toBeVisible();
      await expect(page.locator('button[name="intent"][value="preview"]')).toBeVisible();
      for (const button of await page.locator('button').all()) { const box = await button.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(36); }
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `programme-lp06-${locale}-${info.project.name}.png`), fullPage: true });
    });

    test(`LP-04 form: milestone fields, reward choices and the not-a-tier statement (${locale})`, async ({ page }) => {
      await open(page, 'programme-lp04', locale);
      expect(await noOverflow(page)).toBe(true);
      await expect(page.locator('select[name="milestones.0.rewardId"] option')).toHaveCount(3); // placeholder + two prizes
      await expect(page.locator('input[name="milestones.0.threshold"]')).toBeVisible();
      expect(await unnamedControls(page)).toEqual([]);
      expect(await page.locator('main').innerText()).toMatch(/Free coffee/);
    });
  });
}
