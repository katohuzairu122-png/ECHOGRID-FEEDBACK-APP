import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Cloudflare's static-asset serving 307-redirects an asset URL whose path contains percent-encoded parentheses to the
 * literal-parentheses form, and browsers re-encode it: an endless redirect. Next.js writes route-group directories
 * `(group)` into chunk URLs as `%28group%29`, so any route group makes that page's JavaScript fail to load on the
 * deployed Worker (found on the first CASHIER-PWA staging deployment; local workerd does not reproduce it). The app
 * therefore uses no route groups. Wrap shared chrome in a component instead.
 */
function directories(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const full = join(root, name);
    return statSync(full).isDirectory() ? [full, ...directories(full)] : [];
  });
}

describe('app directory has no route groups or parenthesised segments', () => {
  it('finds none', () => {
    const offenders = directories(join(__dirname)).filter((d) => /[()]/.test(d.slice(__dirname.length)));
    expect(offenders).toEqual([]);
  });
});
