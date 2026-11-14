import { describe, expect, it } from 'vitest';
import config from '../next.config';

/**
 * The camera permission is the one browser capability the cashier scanner needs. Pin exactly where it is allowed so it
 * can neither be lost (scanning breaks, as on the first staging device test) nor spread to the rest of the site.
 */
describe('Permissions-Policy per route', () => {
  async function policyFor(path: string): Promise<string | undefined> {
    const rules = await (config as unknown as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> }).headers();
    let value: string | undefined;
    for (const rule of rules) {
      const pattern = new RegExp(
        // path-to-regexp: a trailing `/:path*` matches the bare path as well as everything beneath it.
        '^' + rule.source.replace(/\/:path\*$/, '(?:/.*)?').replace(/\//g, '\\/') + '$',
      );
      if (!pattern.test(path)) continue;
      for (const h of rule.headers) if (h.key === 'Permissions-Policy') value = h.value; // later rules win
    }
    return value;
  }

  it('allows the camera for this origin on the cashier app and the dashboard scan page', async () => {
    for (const p of ['/cashier', '/cashier/redeem', '/dashboard/loyalty/scan']) {
      expect(await policyFor(p), p).toMatch(/camera=\(self\)/);
    }
  });

  it('keeps the camera denied everywhere else, and microphone and geolocation denied everywhere', async () => {
    for (const p of ['/', '/login', '/dashboard', '/dashboard/billing', '/platform', '/loyalty/abc', '/feedback/x']) {
      expect(await policyFor(p), p).toMatch(/camera=\(\)/);
    }
    for (const p of ['/', '/cashier', '/dashboard/loyalty/scan']) {
      expect(await policyFor(p), p).toMatch(/microphone=\(\)/);
      expect(await policyFor(p), p).toMatch(/geolocation=\(\)/);
    }
  });
});
