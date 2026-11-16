import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-error';

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/customer-api-client', () => ({ customerApiFetch: h.fetch }));

import { requestPhoneCodeAction, verifyPhoneCodeAction } from './customer-phone';

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const api = (code: string, status = 400) => new ApiError('server text that must not be shown', status, code);

beforeEach(() => vi.clearAllMocks());

describe('requestPhoneCodeAction', () => {
  it('posts the number as typed (the API normalizes) and moves to the code step', async () => {
    h.fetch.mockResolvedValue(undefined);
    expect(await requestPhoneCodeAction({}, form({ phone: ' +965 6690 4591 ' }))).toEqual({ sent: true, phone: '+965 6690 4591' });
    expect(h.fetch).toHaveBeenCalledWith('/loyalty/me/phone/request', { method: 'POST', body: JSON.stringify({ phone: '+965 6690 4591' }) }, '/loyalty/dashboard/phone');
  });
  it('an empty number never reaches the API', async () => {
    expect(await requestPhoneCodeAction({}, form({ phone: '  ' }))).toEqual({ error: 'invalid_phone' });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['INVALID_PHONE', 'invalid_phone'], ['OTP_COOLDOWN', 'cooldown'], ['PHONE_ATTACH_LIMITED', 'limited'], ['RATE_LIMITED', 'limited'],
    ['PHONE_ALREADY_VERIFIED', 'already_verified'], ['PHONE_CHANGE_NOT_SUPPORTED', 'change_unsupported'], ['SOMETHING_ELSE', 'unavailable'],
  ])('maps %s to the code %s and never returns the server text', async (apiCode, expected) => {
    h.fetch.mockRejectedValue(api(apiCode, apiCode === 'RATE_LIMITED' || apiCode === 'OTP_COOLDOWN' ? 429 : 409));
    const result = await requestPhoneCodeAction({}, form({ phone: '+96566904591' }));
    expect(result.error).toBe(expected);
    expect(JSON.stringify(result)).not.toContain('server text');
  });
  it('a non-API failure is unavailable', async () => {
    h.fetch.mockRejectedValue(new Error('network'));
    expect((await requestPhoneCodeAction({}, form({ phone: '+96566904591' }))).error).toBe('unavailable');
  });
  it('lets a session redirect through instead of swallowing it', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/loyalty/login;307;' });
    h.fetch.mockRejectedValue(redirect);
    await expect(requestPhoneCodeAction({}, form({ phone: '+96566904591' }))).rejects.toBe(redirect);
  });
});

describe('verifyPhoneCodeAction', () => {
  it('verifies and returns only success and a safe next', async () => {
    h.fetch.mockResolvedValue({ phoneMasked: '+•••••••4591', verified: true });
    const result = await verifyPhoneCodeAction({}, form({ phone: '+96566904591', code: '123456', next: '/loyalty/qr-token?autocheckin=1' }));
    expect(result).toEqual({ verified: true, next: '/loyalty/qr-token?autocheckin=1' });
    expect(h.fetch).toHaveBeenCalledWith('/loyalty/me/phone/verify', { method: 'POST', body: JSON.stringify({ phone: '+96566904591', code: '123456' }) }, '/loyalty/dashboard/phone');
  });
  it('an open-redirect next is neutralised', async () => {
    h.fetch.mockResolvedValue({});
    expect((await verifyPhoneCodeAction({}, form({ phone: '+96566904591', code: '123456', next: 'https://evil.example/' }))).next).toBe('/loyalty/dashboard');
  });
  it('a wrong code keeps the code step open so the customer can retry', async () => {
    h.fetch.mockRejectedValue(api('OTP_INVALID', 401));
    expect(await verifyPhoneCodeAction({}, form({ phone: '+96566904591', code: '000000' }))).toEqual({ error: 'invalid_code', sent: true, phone: '+96566904591' });
  });
  it.each([['OTP_MAX_ATTEMPTS', 'locked'], ['PHONE_TAKEN', 'taken'], ['PHONE_ATTACH_LIMITED', 'limited']])('maps %s to %s', async (apiCode, expected) => {
    h.fetch.mockRejectedValue(api(apiCode, 409));
    expect((await verifyPhoneCodeAction({}, form({ phone: '+96566904591', code: '123456' }))).error).toBe(expected);
  });
  it('missing input never reaches the API', async () => {
    expect((await verifyPhoneCodeAction({}, form({ phone: '+96566904591', code: '' }))).error).toBe('invalid_code');
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
