import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
let host: string | null = null;
vi.mock('next/headers', () => ({ headers: async () => ({ get: () => host }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
import { keepStaffSurfacesOffCashierHost } from './host-guard';

beforeEach(() => vi.unstubAllEnvs());

describe('staff surfaces on the cashier host', () => {
  it('send a request on the cashier host to the cashier app', async () => {
    vi.stubEnv('CASHIER_HOST', 'cashier.echo-grid.uk');
    host = 'cashier.echo-grid.uk';
    await expect(keepStaffSurfacesOffCashierHost()).rejects.toThrow('REDIRECT /cashier');
  });
  it('leave every other host, and an unconfigured environment, untouched', async () => {
    vi.stubEnv('CASHIER_HOST', 'cashier.echo-grid.uk');
    host = 'echo-grid.uk';
    await expect(keepStaffSurfacesOffCashierHost()).resolves.toBeUndefined();
    vi.stubEnv('CASHIER_HOST', '');
    host = 'cashier.echo-grid.uk';
    await expect(keepStaffSurfacesOffCashierHost()).resolves.toBeUndefined();
  });
});
