import { describe, expect, it } from 'vitest';
import { canConfigureProgramme, canReversePurchase, canViewCommunityHub, classifyWorkspace, isCounterStaff } from './workspace-access';

const access = (known: boolean, ...p: string[]) => ({ known, permissions: new Set(p) });
// D-C1 default Staff (cashier) and the historical default (an unreconciled role).
const STAFF = ['business:view', 'branches:view', 'loyalty:serve'];
const LEGACY_STAFF = [
  'business:view',
  'branches:view',
  'feedback:view',
  'loyalty:view',
  'loyalty:manage',
  'messages:view',
  'messages:send',
];

describe('workspace classification (by effective permissions only)', () => {
  it('classifies the default Staff grants as cashier', () => {
    expect(classifyWorkspace(access(true, ...STAFF))).toBe('cashier');
    expect(isCounterStaff(access(true, ...STAFF))).toBe(true);
  });
  it('still presents an unreconciled legacy Staff role as cashier (the API is the authority)', () => {
    expect(classifyWorkspace(access(true, ...LEGACY_STAFF))).toBe('cashier');
  });
  it.each([
    ['accounts directory', 'loyalty:accounts:view'],
    ['manual adjustment', 'loyalty:adjust'],
  ])('is not a cashier when it also holds %s', (_n, key) => {
    expect(classifyWorkspace(access(true, ...STAFF, key))).toBe('management');
  });
  it.each([
    ['owner/admin/manager programme administration', [...STAFF, 'rewards:manage']],
    ['analytics', [...STAFF, 'analytics:view']],
    ['team', [...STAFF, 'team:view']],
    ['billing view', [...STAFF, 'billing:view']],
    ['settings', [...STAFF, 'business:manage_settings']],
    ['feedback triage', [...STAFF, 'feedback:manage']],
    ['branch administration', [...STAFF, 'branches:manage']],
  ])('is not a cashier when it also holds %s', (_n, perms) => {
    expect(classifyWorkspace(access(true, ...perms))).toBe('management');
  });
  it('is not a cashier without any counter-service permission', () => {
    expect(classifyWorkspace(access(true, 'feedback:view'))).toBe('management');
  });
  it('never classifies as cashier, manager or owner when permissions are unknown', () => {
    expect(classifyWorkspace(access(false))).toBe('unavailable');
    expect(classifyWorkspace(access(false, ...STAFF, 'rewards:manage'))).toBe('unavailable');
    expect(isCounterStaff(access(false, ...STAFF))).toBe(false);
    expect(canConfigureProgramme(access(false, 'rewards:manage'))).toBe(false);
  });
  it('lets only rewards:manage configure tiers and rewards', () => {
    expect(canConfigureProgramme(access(true, 'rewards:manage'))).toBe(true);
    expect(canConfigureProgramme(access(true, ...STAFF))).toBe(false);
  });
});

describe('BCOMM-01 canViewCommunityHub (presentation; the API route enforces the same list)', () => {
  it('owner, admin and manager shapes (existing management permissions) may open it', () => {
    for (const permission of ['business:manage_settings', 'analytics:view', 'loyalty:accounts:view', 'rewards:manage', 'feedback:manage', 'team:view']) {
      expect(canViewCommunityHub(access(true, 'business:view', permission)), permission).toBe(true);
    }
  });
  it('counter staff, view-only users and an unconfirmed permission set may not (fail closed)', () => {
    expect(canViewCommunityHub(access(true, 'business:view', 'branches:view', 'loyalty:serve'))).toBe(false); // cashier
    expect(canViewCommunityHub(access(true, 'business:view', 'feedback:view', 'messages:view'))).toBe(false); // view only
    expect(canViewCommunityHub(access(true))).toBe(false);
    expect(canViewCommunityHub(access(false, 'business:manage_settings', 'analytics:view'))).toBe(false); // unknown must never elevate
  });
  it('a cashier who somehow also holds a management permission is a management user, never counter staff', () => {
    expect(classifyWorkspace(access(true, 'loyalty:serve', 'analytics:view'))).toBe('management');
    expect(canViewCommunityHub(access(true, 'loyalty:serve', 'analytics:view'))).toBe(true);
  });
});

describe('purchase reversal visibility (LPC-10; the API enforces loyalty:adjust itself)', () => {
  it('is shown to a management workspace that holds loyalty:adjust', () => {
    expect(canReversePurchase(access(true, ...STAFF, 'loyalty:adjust'))).toBe(true);
  });
  it('is never shown to counter staff, to management without loyalty:adjust, or when permissions are unknown', () => {
    expect(canReversePurchase(access(true, ...STAFF))).toBe(false);
    expect(canReversePurchase(access(true, ...STAFF, 'rewards:manage'))).toBe(false);
    expect(canReversePurchase(access(false, 'loyalty:adjust'))).toBe(false);
    expect(canReversePurchase(access(true, ...LEGACY_STAFF))).toBe(false);
  });
});
