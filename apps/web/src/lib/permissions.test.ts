import { describe, expect, it } from 'vitest';
import { canConfigureProgramme, classifyWorkspace, isCounterStaff } from './workspace-access';

const access = (known: boolean, ...p: string[]) => ({ known, permissions: new Set(p) });
const STAFF = [
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
