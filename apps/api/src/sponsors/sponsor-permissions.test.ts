import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CASHIER_ALLOWED_ROUTES } from '../middleware/cashier-scope';
import { evaluateExternalSponsorAnalyticsAccess, PROPOSED_TENTASHIP_PERMISSIONS } from './sponsor-permissions';

describe('G6 proposed Tentaship permissions are definitions only', () => {
  it('none is in the live permission catalogue, and no cashier route is a Tentaship path', () => {
    const seed = readFileSync(join(process.cwd(), 'src/db/seed/permissions.seed.ts'), 'utf8');
    for (const p of PROPOSED_TENTASHIP_PERMISSIONS) { expect(seed.includes(`'${p.key}'`), p.key).toBe(false); expect(p.status).toBe('proposed'); expect(p.cashierAllowListed).toBe(false); }
    for (const r of CASHIER_ALLOWED_ROUTES) expect(r.pattern.source).not.toMatch(/shuffle|drops|tentaship|governance|sponsor/i);
    expect(new Set(PROPOSED_TENTASHIP_PERMISSIONS.map((p) => p.key)).size).toBe(PROPOSED_TENTASHIP_PERMISSIONS.length);
    expect(PROPOSED_TENTASHIP_PERMISSIONS.filter((p) => p.audience === 'business_staff').map((p) => p.key)).toEqual(['drops:fulfillment:verify']);
  });
  it('external sponsor analytics access is always refused until approvals exist', () => {
    const d = evaluateExternalSponsorAnalyticsAccess();
    expect(d.allowed).toBe(false); expect(d.requires.length).toBe(3);
  });
});
