import { describe, expect, it } from 'vitest';
import { checkCompatibility, checkOverlay, evaluateOverlays, type OverlayCandidate, type OverlayContext, type OverlayPolicy } from './overlay-guard';

const approved: OverlayPolicy = { version: 3, status: 'approved' };
const unapproved: OverlayPolicy = { version: 3, status: 'unapproved' };
const overlay = (over: Partial<OverlayCandidate> = {}): OverlayCandidate => ({
  id: 'o1', kind: 'birthday', businessId: 'biz-a', startsAt: new Date('2026-06-01T00:00:00Z'), endsAt: new Date('2026-07-01T00:00:00Z'),
  customerCap: 1, budget: '10.000', spent: '0.000', awardValue: '2.500', awardKey: 'o1:cust-1:2026', ...over,
});
const context = (over: Partial<OverlayContext> = {}): OverlayContext => ({ businessId: 'biz-a', now: new Date('2026-06-15T00:00:00Z'), customerAwardsInPeriod: 0, existingAwardKeys: new Set(), ...over });

describe('overlay enforcement boundaries (LPC-12/13, policy-neutral)', () => {
  it('refuses everything while the policy is unapproved, whatever the overlay looks like', () => {
    expect(checkOverlay(unapproved, overlay(), context())).toEqual({ ok: false, reason: 'POLICY_UNAPPROVED', policyVersion: 3 });
    const result = evaluateOverlays(unapproved, [overlay(), overlay({ id: 'o2' })], context());
    expect(result.eligible).toEqual([]);
    expect(result.refused.map((r) => r.reason)).toEqual(['POLICY_UNAPPROVED', 'POLICY_UNAPPROVED']);
  });

  it('accepts an overlay that passes every boundary and records the policy version', () => {
    expect(checkOverlay(approved, overlay(), context())).toEqual({ ok: true, policyVersion: 3 });
  });

  it('tenant isolation: another business’s overlay is never eligible', () => {
    expect(checkOverlay(approved, overlay({ businessId: 'biz-b' }), context())).toMatchObject({ reason: 'TENANT_MISMATCH' });
  });

  it('expiry is exact at both edges (start inclusive, end exclusive)', () => {
    expect(checkOverlay(approved, overlay(), context({ now: new Date('2026-05-31T23:59:59.999Z') }))).toMatchObject({ reason: 'NOT_YET_ACTIVE' });
    expect(checkOverlay(approved, overlay(), context({ now: new Date('2026-06-01T00:00:00Z') }))).toMatchObject({ ok: true });
    expect(checkOverlay(approved, overlay(), context({ now: new Date('2026-07-01T00:00:00Z') }))).toMatchObject({ reason: 'EXPIRED' });
    expect(checkOverlay(approved, overlay({ endsAt: null }), context({ now: new Date('2030-01-01T00:00:00Z') }))).toMatchObject({ ok: true });
  });

  it('a replayed award key is a duplicate (concurrent or repeated delivery)', () => {
    expect(checkOverlay(approved, overlay(), context({ existingAwardKeys: new Set(['o1:cust-1:2026']) }))).toMatchObject({ reason: 'DUPLICATE_AWARD' });
  });

  it('customer cap: the cap is reached, not exceeded; no cap stated means none enforced here', () => {
    expect(checkOverlay(approved, overlay({ customerCap: 2 }), context({ customerAwardsInPeriod: 1 }))).toMatchObject({ ok: true });
    expect(checkOverlay(approved, overlay({ customerCap: 2 }), context({ customerAwardsInPeriod: 2 }))).toMatchObject({ reason: 'CUSTOMER_CAP_REACHED' });
    expect(checkOverlay(approved, overlay({ customerCap: null }), context({ customerAwardsInPeriod: 99 }))).toMatchObject({ ok: true });
  });

  it('campaign budget is exact to the fils: exactly the budget fits, one fils over does not (KWD)', () => {
    expect(checkOverlay(approved, overlay({ budget: '10.000', spent: '7.500', awardValue: '2.500' }), context())).toMatchObject({ ok: true });
    expect(checkOverlay(approved, overlay({ budget: '10.000', spent: '7.500', awardValue: '2.501' }), context())).toMatchObject({ reason: 'BUDGET_EXHAUSTED' });
    expect(checkOverlay(approved, overlay({ budget: '0.999', spent: '0.666', awardValue: '0.333' }), context())).toMatchObject({ ok: true });
    expect(checkOverlay(approved, overlay({ budget: null }), context())).toMatchObject({ ok: true });
  });

  it('compatibility is undefined until the Owner supplies a matrix: nothing stacks or is excluded by default', () => {
    expect(checkCompatibility(approved, overlay(), overlay({ id: 'o2', kind: 'referral' }))).toMatchObject({ reason: 'COMPATIBILITY_UNDEFINED' });
    const withMatrix: OverlayPolicy = { ...approved, compatibility: [['birthday', 'referral']] };
    expect(checkCompatibility(withMatrix, overlay(), overlay({ id: 'o2', kind: 'referral' }))).toMatchObject({ ok: true });
    expect(checkCompatibility(withMatrix, overlay({ kind: 'referral' }), overlay({ id: 'o2', kind: 'birthday' }))).toMatchObject({ ok: true });
    expect(checkCompatibility(withMatrix, overlay(), overlay({ id: 'o3', kind: 'happy-hour' }))).toMatchObject({ reason: 'INCOMPATIBLE' });
    expect(checkCompatibility(unapproved, overlay(), overlay({ id: 'o2' }))).toMatchObject({ reason: 'POLICY_UNAPPROVED' });
    expect(checkCompatibility({ ...withMatrix }, overlay(), overlay({ id: 'o2', businessId: 'biz-b' }))).toMatchObject({ reason: 'TENANT_MISMATCH' });
  });

  it('never chooses a winner among eligible overlays: selection stays undecided and input order is preserved', () => {
    const result = evaluateOverlays(approved, [overlay({ id: 'a' }), overlay({ id: 'b', awardKey: 'k2' }), overlay({ id: 'c', businessId: 'biz-b' })], context());
    expect(result.eligible.map((o) => o.id)).toEqual(['a', 'b']);
    expect(result.refused.map((r) => [r.overlay.id, r.reason])).toEqual([['c', 'TENANT_MISMATCH']]);
    expect(result.selection).toBe('UNDECIDED');
  });
});
