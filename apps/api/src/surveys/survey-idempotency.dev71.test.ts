import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/client';
import {
  assertReusableSurveyParticipation,
  SurveyParticipationService,
} from './survey-participation.service';

const mocks = vi.hoisted(() => ({
  findCampaign: vi.fn(),
  findSurvey: vi.fn(),
  findVersion: vi.fn(),
  findByKey: vi.fn(),
  findActiveConsent: vi.fn(),
  createIdempotent: vi.fn(),
  attachConsent: vi.fn(),
  createConsent: vi.fn(),
}));

vi.mock('../repositories', () => ({
  createRepositories: () => ({
    surveys: {
      findCampaignById: mocks.findCampaign,
      findById: mocks.findSurvey,
      findVersionById: mocks.findVersion,
    },
    surveyParticipations: {
      findByCampaignIdempotencyKey: mocks.findByKey,
      createIdempotent: mocks.createIdempotent,
      attachConsentGrant: mocks.attachConsent,
    },
    consentGrants: {
      findActiveForResource: mocks.findActiveConsent,
      create: mocks.createConsent,
    },
  }),
}));

const existing = {
  id: 'participation-a',
  participantCustomerId: 'customer-a',
  consentGrantId: 'consent-a',
  status: 'started' as const,
};

function service() {
  const db = {
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({}),
  } as unknown as Database;
  return new SurveyParticipationService(db);
}

const start = () => service().start('customer-a', 'campaign-a', {
  idempotencyKey: 'unique-key-123',
  consentAccepted: true,
  consentVersion: 'v1',
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.findCampaign.mockResolvedValue({
    id: 'campaign-a', surveyId: 'survey-a', surveyVersionId: 'version-a',
    status: 'active', startsAt: null, endsAt: null, businessId: null,
    repeatPolicy: 'repeatable', maxResponses: null,
    audienceClass: 'general_authenticated_participant',
  });
  mocks.findSurvey.mockResolvedValue({
    id: 'survey-a', ownerType: 'platform', businessId: null, status: 'published',
  });
  mocks.findVersion.mockResolvedValue({
    id: 'version-a', surveyId: 'survey-a', status: 'published',
  });
  mocks.findActiveConsent.mockResolvedValue({ id: 'consent-a' });
});

describe('DEV-71 survey idempotency replay status integrity', () => {
  it('denies a participation invalidated before the first read without renewing consent', async () => {
    mocks.findByKey.mockResolvedValueOnce({ ...existing, status: 'invalidated' });
    await expect(start()).rejects.toMatchObject({
      status: 409, code: 'SURVEY_PARTICIPATION_INVALIDATED',
    });
    expect(mocks.findActiveConsent).not.toHaveBeenCalled();
    expect(mocks.attachConsent).not.toHaveBeenCalled();
  });

  it('denies an invalidated row first observed after the repeat-policy lock', async () => {
    mocks.findByKey.mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ...existing, status: 'invalidated' });
    await expect(start()).rejects.toMatchObject({
      status: 409, code: 'SURVEY_PARTICIPATION_INVALIDATED',
    });
    expect(mocks.findByKey).toHaveBeenCalledTimes(2);
    expect(mocks.findActiveConsent).not.toHaveBeenCalled();
    expect(mocks.createIdempotent).not.toHaveBeenCalled();
  });

  it('denies a foreign customer row first observed after the lock', async () => {
    mocks.findByKey.mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ...existing, participantCustomerId: 'foreign-customer' });
    await expect(start()).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(mocks.findActiveConsent).not.toHaveBeenCalled();
  });

  it('denies an invalidated row returned through the final insert-conflict path', async () => {
    mocks.findByKey.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    mocks.createIdempotent.mockResolvedValueOnce({
      participation: { ...existing, status: 'invalidated' }, inserted: false,
    });
    await expect(start()).rejects.toMatchObject({
      status: 409, code: 'SURVEY_PARTICIPATION_INVALIDATED',
    });
    expect(mocks.createIdempotent).toHaveBeenCalledOnce();
    expect(mocks.attachConsent).not.toHaveBeenCalled();
  });

  it('continues reusing valid same-customer participation with consent unchanged', async () => {
    mocks.findByKey.mockResolvedValueOnce(undefined).mockResolvedValueOnce(existing);
    await expect(start()).resolves.toEqual({ participation: existing, inserted: false });
    expect(mocks.findActiveConsent).toHaveBeenCalledOnce();
    expect(mocks.attachConsent).not.toHaveBeenCalled();
  });

  it('keeps the pure replay guard consistent for allowed statuses and denials', () => {
    for (const status of ['started', 'submitted', 'completed'] as const) {
      expect(() => assertReusableSurveyParticipation({ participantCustomerId: 'customer-a', status }, 'customer-a'))
        .not.toThrow();
    }
    expect(() => assertReusableSurveyParticipation({
      participantCustomerId: 'customer-a', status: 'invalidated',
    }, 'customer-a')).toThrow();
  });
});
