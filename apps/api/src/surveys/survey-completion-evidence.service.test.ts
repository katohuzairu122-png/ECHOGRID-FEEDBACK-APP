import { describe, expect, it } from 'vitest';
import { SurveyCompletionEvidenceService } from './survey-completion-evidence.service';

const COMPLETION_ID = crypto.randomUUID();
const CUSTOMER_ID = crypto.randomUUID();
const SURVEY_ID = crypto.randomUUID();
const VERSION_ID = crypto.randomUUID();
const CAMPAIGN_ID = crypto.randomUUID();
const BUSINESS_ID = crypto.randomUUID();
const BRANCH_ID = crypto.randomUUID();
const COMPLETED_AT = new Date('2026-10-07T18:00:00.000Z');

function service(row?: Record<string, unknown>) {
  return new SurveyCompletionEvidenceService({
    surveyParticipations: {
      async findCompletedById(id: string) {
        if (id !== COMPLETION_ID) return undefined;
        return row as never;
      },
    },
  } as never);
}

describe('SurveyCompletionEvidenceService', () => {
  it('projects a completed participation into stable non-economic evidence', async () => {
    const evidence = await service({
      id: COMPLETION_ID,
      participantCustomerId: CUSTOMER_ID,
      surveyId: SURVEY_ID,
      surveyVersionId: VERSION_ID,
      campaignId: CAMPAIGN_ID,
      businessId: BUSINESS_ID,
      branchId: BRANCH_ID,
      source: 'business_qr',
      status: 'completed',
      completedAt: COMPLETED_AT,
    }).getByCompletionRef(COMPLETION_ID);

    expect(evidence).toEqual({
      evidenceVersion: 'v1',
      completionRef: COMPLETION_ID,
      participantCustomerId: CUSTOMER_ID,
      surveyId: SURVEY_ID,
      surveyVersionId: VERSION_ID,
      campaignId: CAMPAIGN_ID,
      businessId: BUSINESS_ID,
      branchId: BRANCH_ID,
      source: 'business_qr',
      completedAt: COMPLETED_AT.toISOString(),
    });

    expect(evidence).not.toHaveProperty('answers');
    expect(evidence).not.toHaveProperty('submissionPayloadHash');
    expect(evidence).not.toHaveProperty('rewardEligible');
    expect(evidence).not.toHaveProperty('communityPoints');
    expect(evidence).not.toHaveProperty('loyaltyPoints');
  });

  it('fails closed when a durable completed participation does not exist', async () => {
    await expect(
      service(undefined).getByCompletionRef(COMPLETION_ID),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'SURVEY_COMPLETION_EVIDENCE_NOT_FOUND',
    });
  });

  it('creates a deterministic non-authoritative event keyed by completionRef', async () => {
    const svc = service({
      id: COMPLETION_ID,
      participantCustomerId: CUSTOMER_ID,
      surveyId: SURVEY_ID,
      surveyVersionId: VERSION_ID,
      campaignId: CAMPAIGN_ID,
      businessId: null,
      branchId: null,
      source: 'direct',
      status: 'completed',
      completedAt: COMPLETED_AT,
    });
    const evidence = await svc.getByCompletionRef(COMPLETION_ID);

    expect(svc.toEvent(evidence)).toEqual({
      type: 'survey.participation.completed',
      eventVersion: 'v1',
      eventKey: `survey-completion:${COMPLETION_ID}`,
      occurredAt: COMPLETED_AT.toISOString(),
      evidence,
    });
  });
});
