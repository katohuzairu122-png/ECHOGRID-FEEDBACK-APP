import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('./api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('./business', () => ({ getActiveBusinessQuiet: vi.fn() }));
import { canConfigureProgramme, isCounterStaff } from './permissions';

const access = (known: boolean, ...p: string[]) => ({ known, permissions: new Set(p) });

describe('role helpers', () => {
  it('treats loyalty:manage without rewards:manage as counter staff', () => {
    expect(isCounterStaff(access(true, 'loyalty:view', 'loyalty:manage'))).toBe(true);
  });
  it('does not treat owners, admins or managers (rewards:manage) as counter staff', () => {
    expect(isCounterStaff(access(true, 'loyalty:manage', 'rewards:manage'))).toBe(false);
  });
  it('never classifies when permissions could not be read', () => {
    expect(isCounterStaff(access(false))).toBe(false);
    expect(canConfigureProgramme(access(false, 'rewards:manage'))).toBe(false);
  });
  it('lets only rewards:manage configure tiers and rewards', () => {
    expect(canConfigureProgramme(access(true, 'rewards:manage'))).toBe(true);
    expect(canConfigureProgramme(access(true, 'loyalty:manage'))).toBe(false);
  });
});
