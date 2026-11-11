import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const customerApiFetch = vi.fn();
vi.mock('@/lib/customer-api-client', () => ({ customerApiFetch: (...a: unknown[]) => customerApiFetch(...a) }));

import { ApiError } from './api-error';
import { submitSurveyAction } from './actions/surveys';

const CAMPAIGN = '11111111-1111-4111-8111-111111111111';
const QUESTION = '22222222-2222-4222-8222-222222222222';
function form(over: Record<string, string | null> = {}) {
  const data = new FormData();
  const base: Record<string, string | null> = {
    campaignId: CAMPAIGN,
    participationKey: 'participation-key-1234',
    consent: 'on',
    answers: JSON.stringify([{ questionId: QUESTION, value: 4 }]),
    ...over,
  };
  for (const [k, v] of Object.entries(base)) if (v !== null) data.set(k, v);
  return data;
}

describe('submitSurveyAction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('consents and starts, then submits the answers, with the SAME participation key for both calls', async () => {
    customerApiFetch.mockResolvedValue({});
    expect(await submitSurveyAction({ status: 'idle' }, form())).toEqual({ status: 'success' });
    expect(customerApiFetch).toHaveBeenNthCalledWith(
      1,
      `/surveys/me/campaigns/${CAMPAIGN}/start`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: 'participation-key-1234', consentAccepted: true, consentVersion: 'v1' }),
      }),
    );
    expect(customerApiFetch).toHaveBeenNthCalledWith(
      2,
      `/surveys/me/campaigns/${CAMPAIGN}/submit`,
      expect.objectContaining({
        body: JSON.stringify({ idempotencyKey: 'participation-key-1234', answers: [{ questionId: QUESTION, value: 4 }] }),
      }),
    );
  });

  it.each([
    ['missing consent', { consent: null }],
    ['bad campaign id', { campaignId: 'nope' }],
    ['short key', { participationKey: 'x' }],
    ['malformed answers JSON', { answers: '{' }],
    ['answer with a bad question id', { answers: JSON.stringify([{ questionId: 'bad', value: 1 }]) }],
  ])('rejects %s without calling the API', async (_name, over) => {
    expect(await submitSurveyAction({ status: 'idle' }, form(over))).toEqual({ status: 'error', failure: 'invalid' });
    expect(customerApiFetch).not.toHaveBeenCalled();
  });

  it('does not submit when start is refused, and reports the failure kind', async () => {
    customerApiFetch.mockRejectedValueOnce(new ApiError('closed', 409));
    expect(await submitSurveyAction({ status: 'idle' }, form())).toEqual({ status: 'error', failure: 'closed' });
    expect(customerApiFetch).toHaveBeenCalledTimes(1);
  });

  it('re-throws framework redirects (expired customer session)', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/loyalty/login;307;' });
    customerApiFetch.mockRejectedValueOnce(redirect);
    await expect(submitSurveyAction({ status: 'idle' }, form())).rejects.toBe(redirect);
  });
});
