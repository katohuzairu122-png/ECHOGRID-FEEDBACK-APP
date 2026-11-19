import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({ fetch: vi.fn(), revalidate: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
vi.mock('@/lib/customer-api-client', () => ({ customerApiFetch: m.fetch }));

import { ApiError } from '@/lib/api-client';
import { joinAssistedAction } from './loyalty-customer';

beforeEach(() => vi.clearAllMocks());

describe('joinAssistedAction (the customer accepts a cashier invitation)', () => {
  it('refuses without explicit consent and never calls the API', async () => {
    expect(await joinAssistedAction('tok', false as unknown as true)).toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(await joinAssistedAction('tok', undefined as unknown as true)).toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it('refuses an empty or oversized token without a round trip', async () => {
    expect(await joinAssistedAction('', true)).toMatchObject({ code: 'ONBOARDING_INVITE_INVALID' });
    expect(await joinAssistedAction('x'.repeat(2049), true)).toMatchObject({ code: 'ONBOARDING_INVITE_INVALID' });
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it('sends ONLY the invitation, the consent and the consent version: no business, branch or cashier', async () => {
    m.fetch.mockResolvedValue({ membership: {}, loyaltyAccount: { id: 'a', businessId: 'biz', points: 0 } });
    const out = await joinAssistedAction('tok.tok.tok', true);
    expect(m.fetch).toHaveBeenCalledTimes(1);
    const [path, init, back] = m.fetch.mock.calls[0]!;
    expect(path).toBe('/customer-memberships/join-assisted');
    expect(JSON.parse(init.body)).toEqual({ inviteToken: 'tok.tok.tok', consentAccepted: true, consentVersion: 'v1' });
    expect(back).toBe('/loyalty/invite/tok.tok.tok');
    expect(out.account?.businessId).toBe('biz');
    expect(m.revalidate).toHaveBeenCalledWith('/loyalty/dashboard');
  });

  it('turns API refusals into state the screen can explain, keeping the code', async () => {
    for (const code of ['ONBOARDING_INVITE_INVALID', 'ONBOARDING_INVITE_USED', 'PHONE_VERIFICATION_REQUIRED']) {
      m.fetch.mockRejectedValueOnce(new ApiError('nope', 409, code));
      expect(await joinAssistedAction('tok.tok.tok', true)).toEqual({ error: 'nope', code });
    }
    m.fetch.mockRejectedValueOnce(new Error('network'));
    expect((await joinAssistedAction('tok.tok.tok', true)).error).toBeTruthy();
  });
});
