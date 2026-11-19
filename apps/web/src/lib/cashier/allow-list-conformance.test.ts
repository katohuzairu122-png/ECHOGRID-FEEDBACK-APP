import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CASHIER-PWA-01 Group 2 conformance: everything the cashier app calls must be inside C2's locked nine-route
 * allow-list (apps/api/src/middleware/cashier-scope.ts: the original eight plus the ONE owner-authorised onboarding-invite route of CASHIER-AUTH-02D). The list is restated here on purpose: if a Group 2 change ever
 * needs another endpoint, this test fails and the allow-list conflict must be reported, not silently widened.
 */
const ALLOWED = new Set([
  'POST /loyalty/actions/resolve-customer',
  'POST /loyalty/actions/lookup-customer',
  'POST /loyalty/actions/lookup-purchase',
  'POST /loyalty/accounts/:p/purchase',
  'GET /loyalty/redemptions/:p',
  'POST /loyalty/redemptions/:p/confirm',
  'GET /businesses/me',
  'GET /auth/me',
  'POST /loyalty/actions/onboarding-invite', // CASHIER-AUTH-02D, owner-authorised
]);

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8');
const normalise = (p: string) => p.replace(/\$\{[^}]+\}/g, ':p');

/** Every apiFetch / cashierApiFetch call: its path template and, within the call, the method. */
function calls(source: string, fn: string): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  const re = new RegExp(`${fn}(?:<[^>]*>)?\\(\\s*([\`'])([^\`']+)\\1([\\s\\S]*?)\\)\\s*;?\\n`, 'g');
  for (const m of source.matchAll(re)) {
    const method = /method:\s*'(\w+)'/.exec(m[3] ?? '')?.[1] ?? 'GET';
    out.push({ method, path: normalise(m[2]!) });
  }
  return out;
}

describe('cashier app stays inside the nine-route allow-list', () => {
  it('the reused Serve Customers actions only call allowed routes', () => {
    const unified = calls(read('lib/actions/unified-qr.ts'), 'apiFetch');
    expect(unified.length).toBeGreaterThanOrEqual(6);
    for (const c of unified) expect(ALLOWED, `${c.method} ${c.path}`).toContain(`${c.method} ${c.path}`);
  });

  it('the redemption lookup and confirm actions only call allowed routes', () => {
    const src = read('lib/actions/loyalty.ts');
    const tail = src.slice(src.indexOf('export async function lookupRedemptionAction'));
    const found = calls(tail, 'apiFetch');
    expect(found).toHaveLength(2);
    for (const c of found) expect(ALLOWED, `${c.method} ${c.path}`).toContain(`${c.method} ${c.path}`);
  });

  it('the cashier layout reads only /auth/me through its own client; no cashier code calls anything else', () => {
    const own = [
      ...calls(read('components/cashier/cashier-shell.tsx'), 'cashierApiFetch'),
      ...calls(read('app/cashier/page.tsx'), 'cashierApiFetch'),
    ];
    expect(own).toEqual([{ method: 'GET', path: '/auth/me' }]);
    // The only direct API call in the cashier actions is the one authorised invitation issuer; everything else reuses the Serve Customers actions.
    expect(calls(read('lib/cashier/actions.ts'), 'apiFetch')).toEqual([{ method: 'POST', path: '/loyalty/actions/onboarding-invite' }]);
    expect(calls(read('lib/cashier/auth-api.ts'), 'apiFetch')).toEqual([]);
  });

  it('the cashier sign-in endpoints are the C3 auth routes, which take no bearer token', () => {
    const src = read('lib/cashier/actions.ts');
    expect(src).toContain('postCashierAuth');
    expect(read('lib/cashier/auth-api.ts')).toContain('/auth/cashier/');
    expect(src).not.toMatch(/\/platform|\/team|\/billing|\/businesses\//);
  });
});
