import { defineConfig, devices } from '@playwright/test';

/**
 * Real-Chromium acceptance for CONTAINED, unrouted UI components (TSH-06 campaign card, TDP-04 sponsorship report). These components are deliberately rendered by no
 * route, so this config needs NO dev server, API or database: the spec renders each component to static HTML with the app's own compiled Tailwind CSS and loads it in a
 * real browser at desktop and mobile sizes, in LTR and Arabic RTL. It adds no route and no middleware change.
 */
export default defineConfig({
  testDir: './e2e/components',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
