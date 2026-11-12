import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const redirect = vi.fn((to: string) => {
  throw new Error('REDIRECT:' + to);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));
vi.mock('@/components/workspace/restricted-panel', () => ({
  RestrictedPanel: () => null,
}));
const access = vi.fn();
vi.mock('./permissions', async () => ({
  ...(await vi.importActual<object>('./workspace-access')),
  getMyAccess: () => access(),
}));

import { CASHIER_HOME, managementGate, programmeGate } from './workspace-guard';

const STAFF = [
  'business:view',
  'branches:view',
  'feedback:view',
  'loyalty:view',
  'loyalty:manage',
  'messages:view',
];
const variantOf = (node: unknown) => (node as { props: { variant: string } }).props.variant;
const set = (known: boolean, ...p: string[]) =>
  access.mockResolvedValue({ known, permissions: new Set(p) });

describe('workspace guards', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends a cashier to the cashier home, never to another privileged page', async () => {
    set(true, ...STAFF);
    await expect(managementGate()).rejects.toThrow('REDIRECT:' + CASHIER_HOME);
    await expect(programmeGate()).rejects.toThrow('REDIRECT:' + CASHIER_HOME);
    expect(CASHIER_HOME).toBe('/dashboard/loyalty/scan');
    expect(redirect).not.toHaveBeenCalledWith('/dashboard/loyalty');
  });

  it('shows an explicit unavailable state when permissions are unknown (no redirect, no page)', async () => {
    set(false, ...STAFF, 'rewards:manage');
    expect(variantOf(await managementGate())).toBe('unavailable');
    expect(variantOf(await programmeGate())).toBe('unavailable');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('lets a manager through, and gates programme configuration on rewards:manage', async () => {
    set(true, ...STAFF, 'rewards:manage', 'analytics:view');
    expect(await managementGate()).toBeNull();
    expect(await programmeGate()).toBeNull();
    set(true, ...STAFF, 'analytics:view');
    expect(await managementGate()).toBeNull();
    expect(variantOf(await programmeGate())).toBe('forbidden');
  });
});
