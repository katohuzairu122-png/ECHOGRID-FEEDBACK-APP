// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ApiError } from '@/lib/api-error';
import { CUSTOMER_PENDING_PHONE_COOKIE, CUSTOMER_TOKEN_COOKIE } from '@/lib/customer-cookies';
import { publicApiFetch } from '@/lib/public-api-client';
import { POST } from './route';

vi.mock('@/lib/public-api-client', () => ({ publicApiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ ApiError }));

const phone = '+15551234567';
const next = '/loyalty/qr-token?autocheckin=1&feedback=received';

function request(fields: Record<string, string>, pendingPhone: string | null = phone) {
  return new NextRequest('https://echo-grid.uk/api/customer-auth/otp/verify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(pendingPhone ? { Cookie: `${CUSTOMER_PENDING_PHONE_COOKIE}=${encodeURIComponent(pendingPhone)}` } : {}),
    },
    body: new URLSearchParams(fields),
  });
}

describe('loyalty OTP verification route', () => {
  beforeEach(() => vi.resetAllMocks());

  it('verifies the server-bound phone and writes only the login cookie on the QR redirect', async () => {
    vi.mocked(publicApiFetch).mockResolvedValue({ accessToken: 'customer-token' });
    const response = await POST(request({ code: '123456', next }));

    expect(publicApiFetch).toHaveBeenCalledWith('/customer-auth/otp/verify', {
      method: 'POST', body: JSON.stringify({ phone, code: '123456' }),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`https://echo-grid.uk${next}`);
    expect(response.cookies.getAll()).toHaveLength(1);
    expect(response.cookies.get(CUSTOMER_TOKEN_COOKIE)).toMatchObject({
      value: 'customer-token', httpOnly: true, sameSite: 'lax', path: '/', maxAge: 90 * 24 * 60 * 60,
    });
    expect(response.cookies.get(CUSTOMER_PENDING_PHONE_COOKIE)).toBeUndefined();
  });

  it('returns expired requests to phone entry while preserving the QR destination', async () => {
    const response = await POST(request({ code: '123456', next }, null));
    const target = new URL(response.headers.get('location')!);
    expect(target.pathname).toBe('/loyalty/login');
    expect(target.searchParams.get('next')).toBe(next);
    expect(target.searchParams.get('phone')).toBe('');
    expect(target.searchParams.get('error')).toContain('request expired');
    expect(publicApiFetch).not.toHaveBeenCalled();
    expect(response.cookies.get(CUSTOMER_TOKEN_COOKIE)).toBeUndefined();
  });

  it('rejects a posted phone that differs from the server-bound phone', async () => {
    const response = await POST(request({ phone: '+15557654321', code: '123456', next }));
    const target = new URL(response.headers.get('location')!);
    expect(target.searchParams.get('error')).toContain('does not match');
    expect(publicApiFetch).not.toHaveBeenCalled();
  });

  it('keeps invalid codes on code entry without creating a customer session', async () => {
    vi.mocked(publicApiFetch).mockRejectedValue(new ApiError('Code is invalid or has expired.', 400));
    const response = await POST(request({ code: '000000', next }));
    const target = new URL(response.headers.get('location')!);
    expect(target.searchParams.get('phone')).toBe(phone);
    expect(target.searchParams.get('next')).toBe(next);
    expect(target.searchParams.get('error')).toBe('Code is invalid or has expired.');
    expect(response.cookies.get(CUSTOMER_TOKEN_COOKIE)).toBeUndefined();
  });
});
