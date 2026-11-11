import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(fn: T) => fn }));
let cookieValue: string | undefined;
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => (cookieValue ? { value: cookieValue } : undefined) }) }));
const getCustomerToken = vi.fn();
vi.mock('./customer-session', () => ({ getCustomerToken: () => getCustomerToken() }));
vi.mock('./api-client', () => ({
  API_BASE_URL: 'https://api.test',
  parseEnvelope: async (r: Response) => ((await r.json()) as { data: unknown }).data,
}));

import { getLocaleOverride } from './customer-language';

const ok = (locale: string | null) => new Response(JSON.stringify({ success: true, data: { locale } }));

describe('getLocaleOverride precedence', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    cookieValue = undefined;
    getCustomerToken.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);
  });

  it('saved customer preference beats the cookie', async () => {
    getCustomerToken.mockResolvedValue('tok');
    cookieValue = 'es';
    fetchMock.mockResolvedValue(ok('fr'));
    expect(await getLocaleOverride()).toBe('fr');
  });

  it('no saved preference: the cookie applies', async () => {
    getCustomerToken.mockResolvedValue('tok');
    cookieValue = 'es';
    fetchMock.mockResolvedValue(ok(null));
    expect(await getLocaleOverride()).toBe('es');
  });

  it('API failure degrades to the cookie, never throws', async () => {
    getCustomerToken.mockResolvedValue('tok');
    cookieValue = 'ar';
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await getLocaleOverride()).toBe('ar');
  });

  it('anonymous: cookie only, no API call; unsupported cookie ignored', async () => {
    cookieValue = 'de';
    expect(await getLocaleOverride()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    cookieValue = 'fr';
    expect(await getLocaleOverride()).toBe('fr');
  });
});
