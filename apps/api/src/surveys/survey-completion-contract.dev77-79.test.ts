import { describe, expect, it } from 'vitest';
import {
  surveyCompletionEvidenceSchema,
  surveyCompletionEventSchema,
} from '@echo-grid-feedback/shared-types';

const completionRef = '11111111-1111-4111-8111-111111111111';
const evidence = {
  evidenceVersion: 'v1' as const,
  completionRef,
  participantCustomerId: '22222222-2222-4222-8222-222222222222',
  surveyId: '33333333-3333-4333-8333-333333333333',
  surveyVersionId: '44444444-4444-4444-8444-444444444444',
  campaignId: '55555555-5555-4555-8555-555555555555',
  businessId: null,
  branchId: null,
  source: 'direct' as const,
  completedAt: '2026-11-07T12:00:00.000Z',
};
const event = {
  type: 'survey.participation.completed' as const,
  eventVersion: 'v1' as const,
  eventKey: `survey-completion:${completionRef}`,
  occurredAt: evidence.completedAt,
  evidence,
};

describe('Group 11 durable survey completion envelope', () => {
  it('accepts consistent immutable completion evidence and event', () => {
    expect(surveyCompletionEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(surveyCompletionEventSchema.safeParse(event).success).toBe(true);
  });
  it('DEV-77 rejects malformed evidence completion time', () => {
    expect(surveyCompletionEvidenceSchema.safeParse({ ...evidence, completedAt: 'not-a-date' }).success).toBe(false);
  });
  it('DEV-78 rejects malformed event occurrence time', () => {
    expect(surveyCompletionEventSchema.safeParse({ ...event, occurredAt: 'not-a-date' }).success).toBe(false);
  });
  it('DEV-79 rejects a different durable completion reference in the event key', () => {
    expect(surveyCompletionEventSchema.safeParse({
      ...event,
      eventKey: 'survey-completion:99999999-9999-4999-8999-999999999999',
    }).success).toBe(false);
  });
  it('DEV-79 rejects an event time that differs from the evidence completion time', () => {
    expect(surveyCompletionEventSchema.safeParse({
      ...event,
      occurredAt: '2026-11-07T12:00:01.000Z',
    }).success).toBe(false);
  });
  it('rejects a mismatched embedded completion reference', () => {
    expect(surveyCompletionEventSchema.safeParse({
      ...event,
      evidence: { ...evidence, completionRef: '99999999-9999-4999-8999-999999999999' },
    }).success).toBe(false);
  });
});
