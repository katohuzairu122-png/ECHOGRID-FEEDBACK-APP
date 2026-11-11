import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
const set = vi.fn();
vi.mock('next/headers', () => ({ cookies: async () => ({ set }) }));
const getCustomerToken = vi.fn();
vi.mock('@/lib/customer-session', () => ({ getCustomerToken: () => getCustomerToken() }));
vi.mock('@/lib/api-client', () => ({ API_BASE_URL: 'https://api.test' }));

import { setLanguageAction } from './actions/language';

describe('setLanguageAction', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('rejects an unsupported locale without side effects', async () => {
    expect(await setLanguageAction('de')).toEqual({ ok: false });
    expect(set).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('anonymous visitor: sets the cookie only', async () => {
    getCustomerToken.mockResolvedValue(undefined);
    expect(await setLanguageAction('fr')).toEqual({ ok: true });
    expect(set).toHaveBeenCalledWith('ff_locale', 'fr', expect.objectContaining({ path: '/', sameSite: 'lax' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signed-in customer: sets the cookie and persists to the API with their token', async () => {
    getCustomerToken.mockResolvedValue('tok');
    fetchMock.mockResolvedValue(new Response('{}'));
    expect(await setLanguageAction('ar')).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('https://api.test/api/v1/customer-language', expect.objectContaining({
      method: 'PUT',
      headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
      body: JSON.stringify({ locale: 'ar' }),
    }));
  });

  it('persistence failure never blocks the language switch', async () => {
    getCustomerToken.mockResolvedValue('tok');
    fetchMock.mockRejectedValue(new Error('network'));
    expect(await setLanguageAction('es')).toEqual({ ok: true });
    expect(set).toHaveBeenCalled();
  });
});
