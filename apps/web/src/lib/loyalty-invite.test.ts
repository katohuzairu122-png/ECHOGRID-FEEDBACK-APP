import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/customer-api-client', () => ({ customerApiFetch: m.fetch }));

import { INVITE_TOKEN_PATTERN, previewAssistedInvite } from './loyalty-invite';

beforeEach(() => vi.clearAllMocks());

describe('invitation token shape', () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXZhbHVl';
  it('accepts a compact signed token', () => expect(INVITE_TOKEN_PATTERN.test(token)).toBe(true));
  it('refuses anything else before it reaches the API', () => {
    for (const bad of ['', 'short', `${token}/extra`, `${token}?x=1`, `${token} `, 'a'.repeat(2049), '../../etc/passwd'.padEnd(30, 'x'), `${token}%2F`]) {
      expect(INVITE_TOKEN_PATTERN.test(bad), bad.slice(0, 30)).toBe(false);
    }
  });
});

describe('previewAssistedInvite', () => {
  it('posts only the token to the read-only preview endpoint, uncached, and returns to the invitation after a session expiry', async () => {
    m.fetch.mockResolvedValue({ status: 'ready', businessName: 'Cafe', branchName: 'Main', businessId: 'b', expiresAt: 'x' });
    const out = await previewAssistedInvite('tok.tok.tok');
    expect(m.fetch).toHaveBeenCalledWith(
      '/customer-memberships/join-assisted/preview',
      { method: 'POST', body: JSON.stringify({ inviteToken: 'tok.tok.tok' }), cache: 'no-store' },
      '/loyalty/invite/tok.tok.tok',
    );
    expect(out.status).toBe('ready');
  });
});
