import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from './client';
import { runAcceptance } from './runner';
import { SCENARIOS, firstMissing, missingCapability, type Context, type CustomerProvisioner, type World } from './scenarios';

const world = (a: number, b = 1): World => ({ branchesA: Array.from({ length: a }, (_, i) => `a${i}`), branchesB: Array.from({ length: b }, (_, i) => `b${i}`) } as unknown as World);
const prov = (over: Partial<CustomerProvisioner> = {}, noReturning = false): CustomerProvisioner => {
  const p: CustomerProvisioner = { kind: 'test', canSetPhoneVerified: true, create: async () => ({ id: 'x', token: 'y' }), returning: async () => ({ id: 'x', token: 'y' }), ...over };
  if (noReturning) delete p.returning;
  return p;
};
const ctx = (provisioner: CustomerProvisioner | null): Context => ({ api: {} as ApiClient, runId: 'dep001', ownerA: { email: 'a', password: 'p', businessId: 'a' }, ownerB: { email: 'b', password: 'p', businessId: 'b' }, provisioner });

describe('scenario dependencies are explicit', () => {
  it('every scenario that creates customers declares the customers capability', () => {
    for (const id of ['S04', 'S05', 'S07', 'S10', 'S11', 'S12', 'S13', 'S15']) expect(SCENARIOS.find((s) => s.id === id)?.requires, id).toContain('customers');
    expect(SCENARIOS.find((s) => s.id === 'S13')?.requires).toEqual(expect.arrayContaining(['phone-verified-customers', 'second-business']));
    expect(SCENARIOS.find((s) => s.id === 'S15')?.requires).toContain('returning-customers');
    expect(SCENARIOS.find((s) => s.id === 'S12')?.requires).toContain('branches-3');
  });
  it('resolves each capability with a stated reason', () => {
    expect(missingCapability('customers', ctx(null), world(3))).toMatch(/approved staging hostnames, test mailbox and customer provisioning/);
    expect(missingCapability('customers', ctx(prov()), world(3))).toBeNull();
    expect(missingCapability('returning-customers', ctx(prov({}, true)), world(3))).toMatch(/sign a customer in again/);
    expect(missingCapability('returning-customers', ctx(prov()), world(3))).toBeNull();
    expect(missingCapability('phone-verified-customers', ctx(prov({ canSetPhoneVerified: false })), world(3))).toMatch(/real SMS code/);
    expect(missingCapability('phone-verified-customers', ctx(prov()), world(3))).toBeNull();
    expect(missingCapability('branches-2', ctx(null), world(1))).toMatch(/at least 2 branches \(has 1\)/);
    expect(missingCapability('branches-3', ctx(null), world(2))).toMatch(/at least 3 branches \(has 2\)/);
    expect(missingCapability('second-business', ctx(null), world(3, 0))).toMatch(/business B needs a branch/);
  });
  it('reports the first missing dependency in declared order', () => {
    const s13 = SCENARIOS.find((s) => s.id === 'S13')!;
    expect(firstMissing(s13, ctx(null), world(1))).toMatch(/at least 2 branches/);
    expect(firstMissing(s13, ctx(null), world(3))).toMatch(/provisioner/);
    expect(firstMissing(s13, ctx(prov({ canSetPhoneVerified: false })), world(3))).toMatch(/SMS/);
    expect(firstMissing(s13, ctx(prov()), world(3, 0))).toMatch(/business B/);
    expect(firstMissing(s13, ctx(prov()), world(3))).toBeNull();
  });

  const api: ApiClient = {
    async request(_m, p) {
      if (p === '/auth/login') return { status: 200, data: { accessToken: 'tok' } };
      if (p === '/cashier-accounts/business-code') return { status: 200, data: { cashierCode: '' } };
      if (p === '/branches') return { status: 200, data: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] };
      return { status: 200, data: { totals: { events: 0, uniqueCustomers: 0, rejoinEvents: 0 }, bySource: [], byBranch: [] } };
    },
  };
  it('a missing dependency is always NOT RUN with its reason, never PASS or FAIL', async () => {
    const out = await runAcceptance({ ctx: { ...ctx(null), api }, mode: 'local', commit: 'abcdef0', only: ['S04', 'S05', 'S07', 'S10', 'S11', 'S12', 'S13', 'S15'] });
    expect(out.report.counts.pass).toBe(0);
    expect(out.report.counts.fail).toBe(0);
    expect(out.report.checks).toHaveLength(8);
    for (const c of out.report.checks) { expect(c.status).toBe('NOT_RUN'); expect(c.detail).toMatch(/provisioner/); }
  });
  it('without a returning-capable provisioner only the scenarios that need it are NOT RUN', async () => {
    const out = await runAcceptance({ ctx: { ...ctx(prov({}, true)), api }, mode: 'local', commit: 'abcdef0', only: ['S15'] });
    expect(out.report.checks[0]).toMatchObject({ id: 'S15.0', status: 'NOT_RUN' });
    expect(out.report.checks[0]?.detail).toMatch(/sign a customer in again/);
  });
});

describe('browser evidence in the report', () => {
  const api2: ApiClient = { request: async (_m, p) => (p === '/auth/login' ? { status: 200, data: { accessToken: 't' } } : p === '/branches' ? { status: 200, data: [] } : { status: 200, data: { cashierCode: '', totals: {} } }) };
  it('without browser results S14 is NOT RUN, as in E1', async () => {
    const out = await runAcceptance({ ctx: { ...ctx(null), api: api2 }, mode: 'local', commit: 'abcdef0', only: ['S14'] });
    expect(out.report.checks.map((c) => [c.id, c.status])).toEqual([['S14.1', 'NOT_RUN']]);
  });
  it('supplied browser checks become S14 checks with their own statuses', async () => {
    const browser = [{ id: 'B01', title: 'cashier login', status: 'PASS' as const, detail: '' }, { id: 'B02', title: 'overflow', status: 'FAIL' as const, detail: 'scrollWidth 400 > 375' }, { id: 'B03', title: 'customer join', status: 'NOT_RUN' as const, detail: 'no customer session' }];
    const out = await runAcceptance({ ctx: { ...ctx(null), api: api2, browser }, mode: 'local', commit: 'abcdef0', only: ['S14'] });
    expect(out.report.checks.map((c) => [c.id, c.status])).toEqual([['S14.B01', 'PASS'], ['S14.B02', 'FAIL'], ['S14.B03', 'NOT_RUN']]);
  });
});

describe('scenario labels are valid for the live provisioner', () => {
  it('every customer label used by a scenario can form a synthetic address', () => {
    const source = readFileSync(path.join(__dirname, 'scenarios.ts'), 'utf8');
    const labels = [...source.matchAll(/customer\(ctx, w, '([^']*)'/g)].map((m) => m[1] as string);
    expect(labels.length).toBeGreaterThan(8);
    for (const label of labels) expect(label, label).toMatch(/^[a-z0-9]{1,16}$/);
  });
});
