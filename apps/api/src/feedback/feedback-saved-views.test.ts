import { describe, it, expect } from 'vitest';
import { expandSavedView } from './feedback-saved-views';

describe('expandSavedView', () => {
  it('critical_now filters to P0_CRITICAL urgency only', () => {
    expect(expandSavedView('critical_now')).toEqual({ urgency: ['P0_CRITICAL'] });
  });

  it('high_priority_unresolved filters to P0/P1 urgency and new status', () => {
    expect(expandSavedView('high_priority_unresolved')).toEqual({
      urgency: ['P0_CRITICAL', 'P1_HIGH'],
      status: ['new'],
    });
  });

  it('negative_unresolved filters to negative sentiment and new status', () => {
    expect(expandSavedView('negative_unresolved')).toEqual({
      sentiment: ['very_negative', 'negative'],
      status: ['new'],
    });
  });

  it('follow_up_required sets the followUpRequired flag', () => {
    expect(expandSavedView('follow_up_required')).toEqual({ followUpRequired: true });
  });

  it('unclassified filters to pending/failed analysis status', () => {
    expect(expandSavedView('unclassified')).toEqual({ analysisStatus: ['pending', 'failed'] });
  });

  it('recently_resolved filters to reviewed status', () => {
    expect(expandSavedView('recently_resolved')).toEqual({ status: ['reviewed'] });
  });

  it('positive_feedback filters to positive sentiment', () => {
    expect(expandSavedView('positive_feedback')).toEqual({ sentiment: ['very_positive', 'positive'] });
  });
});
