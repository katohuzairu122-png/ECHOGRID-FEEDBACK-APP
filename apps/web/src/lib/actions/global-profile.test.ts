import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/customer-api-client', () => ({ customerApiFetch: fetchMock }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { updateGlobalProfileAction } from './global-profile';

function form(values: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

describe('updateGlobalProfileAction', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('sends only valid values, and turns empty fields into clears', async () => {
    fetchMock.mockResolvedValue({});
    const r = await updateGlobalProfileAction({}, form({ displayName: ' Mina ', bio: '', avatarKey: 'leaf' }));
    expect(r).toEqual({ saved: true });
    expect(fetchMock).toHaveBeenCalledWith('/customer-profile', { method: 'PUT', body: JSON.stringify({ displayName: 'Mina', bio: null, avatarKey: 'leaf' }) });
  });
  it('refuses a name that is a link or an address without calling the API', async () => {
    expect(await updateGlobalProfileAction({}, form({ displayName: 'www.evil.com', bio: '', avatarKey: '' }))).toEqual({ error: 'invalid_name' });
    expect(await updateGlobalProfileAction({}, form({ displayName: 'a@b.co', bio: '', avatarKey: '' }))).toEqual({ error: 'invalid_name' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('refuses an over-long bio and an unknown avatar', async () => {
    expect(await updateGlobalProfileAction({}, form({ displayName: '', bio: 'x'.repeat(281), avatarKey: '' }))).toEqual({ error: 'invalid_bio' });
    expect(await updateGlobalProfileAction({}, form({ displayName: '', bio: '', avatarKey: 'photo.png' }))).toEqual({ error: 'invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('reports unavailable when the API fails, but lets a redirect through', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    expect(await updateGlobalProfileAction({}, form({ displayName: 'Mina', bio: '', avatarKey: '' }))).toEqual({ error: 'unavailable' });
    const redirectError = { digest: 'NEXT_REDIRECT;replace;/loyalty/login;307;' };
    fetchMock.mockRejectedValue(redirectError);
    await expect(updateGlobalProfileAction({}, form({ displayName: 'Mina', bio: '', avatarKey: '' }))).rejects.toBe(redirectError);
  });
});
