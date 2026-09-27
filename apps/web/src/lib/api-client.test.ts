import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { getAccessTokenMock } = vi.hoisted(() => ({
  getAccessTokenMock: vi.fn(),
}));

vi.mock('./session', () => ({
  getAccessToken: getAccessTokenMock,
}));

import { apiFetch } from './api-client';

describe('apiFetch authentication boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAccessTokenMock.mockResolvedValue('access-token');
  });

  it('attaches the current access token without attempting session mutation', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer access-token');
      return Response.json({ success: true, data: { ok: true } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch<{ ok: boolean }>('/branches')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('surfaces a 401 without trying to write cookies during Server Component rendering', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        { success: false, error: { code: 'UNAUTHENTICATED', message: 'Expired.' } },
        { status: 401 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/branches')).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
