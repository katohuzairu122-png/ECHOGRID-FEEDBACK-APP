import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('./api-client', () => ({ API_BASE_URL: 'https://api.test' }));
vi.mock('./cashier/client-attribution', () => ({ signedAttributionHeadersSafe: async () => ({ 'x-echo-client': 'signed' }) }));

import { callCustomerAuthApi } from './customer-email-auth-client';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('callCustomerAuthApi on the Workers runtime', () => {
  it("never sends redirect:'error' (workerd throws a TypeError for it before any request); it uses 'manual'", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    await callCustomerAuthApi('/customer-auth/email/register/request', { body: { email: 'a@example.test' } });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.redirect).toBe('manual');
    expect(init.redirect).not.toBe('error');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.test/api/v1/customer-auth/email/register/request');
  });

  it('a redirect is never followed or read: the 3xx status is returned with no body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } }));
    const reply = await callCustomerAuthApi('/customer-auth/email/login', { body: { email: 'a@example.test', password: 'x' }, bearer: 'secret-token' });
    expect(reply).toEqual({ status: 302, body: null });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no second request to the Location
  });

  it('forwards the signed attribution header and the bearer, and returns a normal status and body', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'x' }), { status: 401 }));
    const reply = await callCustomerAuthApi('/customer-auth/email/login', { body: { a: 1 }, bearer: 'tok' });
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Headers;
    expect(headers.get('x-echo-client')).toBe('signed');
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(reply).toEqual({ status: 401, body: { error: 'x' } });
  });
});
