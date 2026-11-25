import { test, expect } from '@playwright/test';
import { signUpBusinessOwner } from './helpers/signup';

test('Feedback Inbox: honest empty state, keyboard access and responsive layout', async ({
  page,
}) => {
  const unique = Date.now();
  await signUpBusinessOwner(page, { fullName: 'Inbox UI Test', email: `inbox-ui-${unique}@example.test`, password: 'a-strong-test-password' });
  await page.getByLabel('Business name').fill(`Inbox ${unique}`);
  await page.getByRole('button', { name: 'Create business' }).click();
  // BCOMM-01: a new owner lands on the Community hub; these specs exercise the Business Overview, which keeps its own destination.
  await expect(page.getByRole('heading', { name: 'Community', exact: true })).toBeVisible();
  await page.goto('/dashboard/overview');
  await expect(page.getByRole('heading', { name: 'Business Overview', exact: true })).toBeVisible();

  await page.goto('/dashboard/feedback');
  await expect(page.getByRole('heading', { name: 'Feedback', exact: true })).toBeVisible();
  await expect(page.getByText('No feedback yet', { exact: true })).toBeVisible();
  const view = page.getByRole('combobox', { name: 'View', exact: true });
  await expect(view).toHaveValue('');

  // Keyboard: the search field is reachable and a saved view can be chosen from its dropdown.
  await page.getByLabel('Search comments').focus();
  await page.getByLabel('Search comments').fill('nothing matches this');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/search=nothing\+matches\+this/);
  await expect(page.getByText('No feedback matches these filters', { exact: true })).toBeVisible();
  await view.focus();
  await expect(view).toBeFocused();
  await view.selectOption('critical_now');
  await expect(page).toHaveURL(/savedView=critical_now/);
  await expect(page.getByRole('combobox', { name: 'View', exact: true })).toHaveValue('critical_now');

  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
});
