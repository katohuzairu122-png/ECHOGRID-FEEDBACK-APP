import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({ api: vi.fn(), business: vi.fn(), revalidate: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  apiFetch: m.api,
  ApiError: class ApiError extends Error {
    constructor(message: string, public status: number, public code?: string) {
      super(message);
    }
  },
}));
vi.mock('@/lib/business', () => ({ getActiveBusiness: m.business }));
vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));

import { ApiError } from '@/lib/api-client';
import { revokeAllCashierSessionsAction, revokeCashierSessionAction } from './cashier-sessions';

const form = (id: string) => {
  const f = new FormData();
  f.set('sessionId', id);
  return f;
};

beforeEach(() => {
  vi.clearAllMocks();
  m.business.mockResolvedValue({ id: 'biz-1' });
  m.api.mockResolvedValue(undefined);
});

describe('cashier session actions (staff side)', () => {
  it('revokes one session within the active business and refreshes the list', async () => {
    expect(await revokeCashierSessionAction({}, form('abc'))).toEqual({ status: 'revoked' });
    expect(m.api).toHaveBeenCalledWith('/cashier-sessions/abc', { method: 'DELETE', businessId: 'biz-1' });
    expect(m.revalidate).toHaveBeenCalledWith('/dashboard/cashier');
  });

  it('encodes the session id so it cannot alter the request path', async () => {
    await revokeCashierSessionAction({}, form('../../team'));
    expect(m.api.mock.calls[0]![0]).toBe('/cashier-sessions/..%2F..%2Fteam');
  });

  it('revoke-all is business-scoped', async () => {
    expect(await revokeAllCashierSessionsAction()).toEqual({ status: 'revokedAll' });
    expect(m.api).toHaveBeenCalledWith('/cashier-sessions/revoke-all', { method: 'POST', businessId: 'biz-1' });
  });

  it('reports a failure without throwing, and refreshes when the session was already gone', async () => {
    m.api.mockRejectedValue(new ApiError('gone', 404, 'NOT_FOUND'));
    expect(await revokeCashierSessionAction({}, form('abc'))).toEqual({ status: 'failed' });
    expect(m.revalidate).toHaveBeenCalled();
    m.api.mockRejectedValue(new Error('down'));
    expect(await revokeAllCashierSessionsAction()).toEqual({ status: 'failed' });
  });

  it('does nothing without an active business', async () => {
    m.business.mockResolvedValue(null);
    expect(await revokeAllCashierSessionsAction()).toEqual({ status: 'failed' });
    expect(m.api).not.toHaveBeenCalled();
  });
});
