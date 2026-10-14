import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ token: vi.fn(), parse: vi.fn(), notFound: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
vi.mock('@/lib/customer-session', () => ({ getCustomerToken: mocks.token }));
vi.mock('@/lib/api-client', async () => ({
  API_BASE_URL: 'https://api.example.test',
  parseEnvelope: mocks.parse,
  ...(await import('@/lib/api-error')),
}));
import { resolveOptionalQrActions } from './optional-qr-actions';
import { ApiError } from './api-error';
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
  mocks.token.mockResolvedValue('fixture-customer-session');
});
describe('public QR optional customer identity', () => {
  it('does not query private actions when there is no customer session', async () => {
    mocks.token.mockResolvedValue(undefined);
    expect(await resolveOptionalQrActions('signed-business-code')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([401, 403])(
    'keeps anonymous feedback available when customer authentication returns %s',
    async (status) => {
      mocks.parse.mockRejectedValue(new ApiError('Invalid session', status));
      expect(await resolveOptionalQrActions('signed-business-code')).toBeNull();
      expect(mocks.notFound).not.toHaveBeenCalled();
    },
  );
  it('returns only the authenticated API result without attaching staff credentials', async () => {
    const result = { actions: ['CHECK_IN'], businessId: 'verified-business' };
    mocks.parse.mockResolvedValue(result);
    expect(await resolveOptionalQrActions('signed-business-code')).toEqual(result);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/loyalty/me/actions/resolve-business',
      expect.objectContaining({
        cache: 'no-store',
        headers: {
          Authorization: 'Bearer fixture-customer-session',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ businessQrToken: 'signed-business-code' }),
      }),
    );
  });
  it('fails closed for a QR revoked between public resolution and private resolution', async () => {
    mocks.parse.mockRejectedValue(new ApiError('Revoked QR', 404));
    const sentinel = { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' };
    mocks.notFound.mockImplementation(() => {
      throw sentinel;
    });
    await expect(resolveOptionalQrActions('revoked-code')).rejects.toBe(sentinel);
  });
});
