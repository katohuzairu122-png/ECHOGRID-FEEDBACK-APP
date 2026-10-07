import type {
  SurveyCompletionEvidence,
  SurveyCompletionEvent,
} from '@echo-grid-feedback/shared-types';
import type { Repositories } from '../repositories';
import { AppError } from '../lib/errors';

export class SurveyCompletionEvidenceService {
  constructor(
    private readonly repos: Pick<Repositories, 'surveyParticipations'>,
  ) {}

  async getByCompletionRef(completionRef: string): Promise<SurveyCompletionEvidence> {
    const participation =
      await this.repos.surveyParticipations.findCompletedById(completionRef);

    if (!participation || !participation.completedAt) {
      throw new AppError(
        'Survey completion evidence not found.',
        404,
        'SURVEY_COMPLETION_EVIDENCE_NOT_FOUND',
      );
    }

    return {
      evidenceVersion: 'v1',
      completionRef: participation.id,
      participantCustomerId: participation.participantCustomerId,
      surveyId: participation.surveyId,
      surveyVersionId: participation.surveyVersionId,
      campaignId: participation.campaignId,
      businessId: participation.businessId,
      branchId: participation.branchId,
      source: participation.source,
      completedAt: participation.completedAt.toISOString(),
    };
  }

  toEvent(evidence: SurveyCompletionEvidence): SurveyCompletionEvent {
    return {
      type: 'survey.participation.completed',
      eventVersion: 'v1',
      eventKey: `survey-completion:${evidence.completionRef}`,
      occurredAt: evidence.completedAt,
      evidence,
    };
  }
}
