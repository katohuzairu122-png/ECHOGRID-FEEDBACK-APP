import { test, expect } from '@playwright/test';

test('Feedback Inbox: honest empty state, keyboard access and responsive layout', async ({
  page,
}) => {
  const unique = Date.now();
  await page.goto('/signup');
  await page.getByLabel('Full name').fill('Inbox UI Test');
  await page.getByLabel('Email').fill(`inbox-ui-${unique}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('a-strong-test-password');
  await page.getByLabel(/I agree to the Terms of Service/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Business name').fill(`Inbox ${unique}`);
  await page.getByLabel('URL slug').fill(`inbox-ui-${unique}`);
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page.getByRole('heading', { name: 'Business Overview', exact: true })).toBeVisible();

  await page.goto('/dashboard/feedback');
  await expect(page.getByRole('heading', { name: 'Feedback', exact: true })).toBeVisible();
  await expect(page.getByText('No feedback yet', { exact: true })).toBeVisible();
  const views = page.getByRole('navigation', { name: 'Saved views' });
  await expect(views.getByRole('link', { name: 'All', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // Keyboard: the search field is reachable and a saved view can be opened without a pointer.
  await page.getByLabel('Search comments').focus();
  await page.getByLabel('Search comments').fill('nothing matches this');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/search=nothing\+matches\+this/);
  await expect(page.getByText('No feedback matches these filters', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Critical now' }).focus();
  await expect(page.getByRole('link', { name: 'Critical now' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/savedView=critical_now/);

  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
});
