'use server';

import { surveyAnswerInputSchema } from '@echo-grid-feedback/shared-types';
import { customerApiFetch } from '@/lib/customer-api-client';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';
import { classifySurveySubmitError } from '@/lib/survey-submit-failure';
import type { SurveySubmitState } from '@/lib/surveys-types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const key = (value: FormDataEntryValue | null): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length >= 8 && text.length <= 200 ? text : null;
};

/**
 * Customer takes a survey: consent + start, then submit, both on the existing endpoints. The API remains the
 * authority for audience, repeat policy, required answers and validation; this action only shapes the call.
 * A 401 redirects to the customer login (customerApiFetch).
 */
export async function submitSurveyAction(
  _prev: SurveySubmitState,
  form: FormData,
): Promise<SurveySubmitState> {
  let parsedAnswers: unknown;
  try {
    parsedAnswers = JSON.parse(String(form.get('answers') ?? '[]'));
  } catch {
    return { status: 'error', failure: 'invalid' };
  }
  const campaignId = String(form.get('campaignId') ?? '');
  // The API identifies a participation by ONE idempotency key shared by start and submit.
  const participationKey = key(form.get('participationKey'));
  const answers = surveyAnswerInputSchema.array().max(100).safeParse(parsedAnswers);
  if (!UUID.test(campaignId) || !participationKey || form.get('consent') !== 'on' || !answers.success) {
    return { status: 'error', failure: 'invalid' };
  }
  const base = `/surveys/me/campaigns/${encodeURIComponent(campaignId)}`;
  try {
    await customerApiFetch(`${base}/start`, {
      method: 'POST',
      cache: 'no-store',
      body: JSON.stringify({ idempotencyKey: participationKey, consentAccepted: true, consentVersion: 'v1' }),
    });
    await customerApiFetch(`${base}/submit`, {
      method: 'POST',
      cache: 'no-store',
      body: JSON.stringify({ idempotencyKey: participationKey, answers: answers.data }),
    });
    return { status: 'success' };
  } catch (error) {
    rethrowControlFlow(error);
    return { status: 'error', failure: classifySurveySubmitError(error) };
  }
}
