import { test, expect } from '@playwright/test';
import { collapseDevelopmentBadge } from './helpers/development-chrome';
import { signUpBusinessOwner, skipProgrammeSetup } from './helpers/signup';

/**
 * TB-03 in a real browser (business side). TENTASHIP_BADGES_ENABLED is OFF in the default local/CI stack, so the default run proves the control is
 * invisible: no badges section, no teaser, no empty state. The opt-in run (E2E_BADGES_ENABLED=1 with the local API started with the control on,
 * which no checked-in configuration does) proves the open state: honest empty state, "not currency" notice, a working server-side check, 375 px fit.
 */
const open = process.env.E2E_BADGES_ENABLED === '1';
const PASSWORD = 'a-strong-test-password';
const unique = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test('the business Community home shows Tentaship Badges only while the control is open', async ({ page }) => {
  await signUpBusinessOwner(page, { fullName: 'Badge Owner', email: `badges-${unique}@example.test`, password: PASSWORD });
  await expect(page).toHaveURL('/dashboard');
  await page.getByLabel('Business name').fill(`Badges ${unique.replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)] as string)}`);
  await page.getByRole('button', { name: 'Create business' }).click();
  await skipProgrammeSetup(page);
  await page.waitForURL('**/dashboard/community');
  await collapseDevelopmentBadge(page);
  await expect(page.getByRole('heading', { name: 'About Community' }).or(page.getByTestId('community-about'))).toBeVisible();

  const section = page.getByTestId('tentaship-badges');
  if (!open) {
    await expect(section).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/Tentaship Badges/);
    return;
  }
  await expect(section).toBeVisible();
  await expect(section).toContainText('not points, have no cash or other value');
  await expect(section).toContainText('No badges yet.');
  await expect(section.getByRole('button', { name: /redeem|transfer|buy|enter/i })).toHaveCount(0);
  await section.getByRole('button', { name: 'Check for new badges' }).click();
  await expect(section.getByText('No new badges right now.')).toBeVisible();
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
