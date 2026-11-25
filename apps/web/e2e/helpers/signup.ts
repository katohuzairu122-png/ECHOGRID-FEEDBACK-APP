import type { Page } from '@playwright/test';

/**
 * Business-owner sign-up through the real form. The API limits authentication requests per minute per source address, and the whole browser
 * suite signs people up from one address, so a rejected sign-up (the form stays on /signup) is retried after a pause instead of failing a
 * test for a reason that has nothing to do with what it verifies. A rejected request creates nothing, so repeating the same details is safe.
 */
export interface OwnerSignUp {
  fullName: string;
  email: string;
  password: string;
}

const ATTEMPTS = 6;
const SETTLE_MS = 6000;
const PAUSE_MS = 15000;

export async function signUpBusinessOwner(page: Page, owner: OwnerSignUp) {
  for (let attempt = 1; ; attempt += 1) {
    await page.goto('/signup?role=business');
    await page.getByLabel('Full name').fill(owner.fullName);
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password', { exact: true }).fill(owner.password);
    await page.getByLabel(/I agree to the Terms of Service/).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    try {
      await page.waitForURL((url) => !url.pathname.startsWith('/signup'), { timeout: SETTLE_MS });
      return;
    } catch (error) {
      if (attempt >= ATTEMPTS) throw error;
      await page.waitForTimeout(PAUSE_MS);
    }
  }
}
