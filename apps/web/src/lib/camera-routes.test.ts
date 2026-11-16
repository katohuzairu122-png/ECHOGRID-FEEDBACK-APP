import { describe, expect, it } from 'vitest';
import config from '../../next.config';
import { isCameraPath } from './camera-routes';

async function allowsCamera(path: string): Promise<boolean> {
  const rules = await (config as unknown as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> }).headers();
  let value = '';
  for (const rule of rules) {
    const pattern = new RegExp('^' + rule.source.replace(/\/:path\*$/, '(?:/.*)?').replace(/\//g, '\\/') + '$');
    if (!pattern.test(path)) continue;
    for (const h of rule.headers) if (h.key === 'Permissions-Policy') value = h.value;
  }
  return /camera=\(self\)/.test(value);
}

describe('isCameraPath', () => {
  it.each(['/dashboard/loyalty/scan', '/dashboard/loyalty/scan?x=1', '/cashier', '/cashier/redeem', '/cashier/#a'])(
    'treats %s as a camera page',
    (href) => expect(isCameraPath(href)).toBe(true),
  );
  it.each(['/dashboard', '/dashboard/loyalty', '/dashboard/loyalty/scanner', '/cashierx', '/loyalty/dashboard/qr', '/support'])(
    'does not treat %s as a camera page',
    (href) => expect(isCameraPath(href)).toBe(false),
  );
  it('agrees with the routes next.config.ts actually allows the camera on', async () => {
    for (const path of ['/dashboard/loyalty/scan', '/cashier', '/cashier/redeem', '/dashboard', '/dashboard/loyalty', '/support', '/loyalty/dashboard/qr']) {
      expect(isCameraPath(path), path).toBe(await allowsCamera(path));
    }
  });
});
