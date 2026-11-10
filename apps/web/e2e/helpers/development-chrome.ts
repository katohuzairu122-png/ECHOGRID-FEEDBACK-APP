import type { Page } from '@playwright/test';

/** Collapse Next's development-only issue count so it cannot cover fixed
 * workspace controls. This does not dismiss errors or alter application UI.
 * Production/Worker previews have no development badge and take no action. */
export async function collapseDevelopmentBadge(page: Page) {
  const collapse = page
    .locator('nextjs-portal')
    .getByRole('button', { name: 'Collapse issues badge', exact: true });
  // The badge can appear after hydration, between a visibility check and
  // the application's click. Handle it during Playwright actionability checks.
  await page.addLocatorHandler(collapse, async () => {
    await collapse.click();
  });
}
