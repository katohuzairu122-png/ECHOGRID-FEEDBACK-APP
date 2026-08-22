import type { FeedbackFilterInput } from '@echo-grid-feedback/shared-types';

type SavedView = NonNullable<FeedbackFilterInput['savedView']>;

/**
 * Expands a named saved view into the concrete filter fields it represents,
 * applied server-side (feedback.service.ts) before the rest of the caller's
 * own filters -- a saved view is a starting preset, not an override, so a
 * caller can still narrow further (e.g. "Critical now" AND a specific
 * branchId). Only the 7 saved views backed by real data today are
 * representable -- see feedbackFilterSchema's own comment (shared-types)
 * for which three the spec asks for that aren't implementable yet.
 */
export function expandSavedView(view: SavedView): Partial<FeedbackFilterInput> {
  switch (view) {
    case 'critical_now':
      return { urgency: ['P0_CRITICAL'] };
    case 'high_priority_unresolved':
      return { urgency: ['P0_CRITICAL', 'P1_HIGH'], status: ['new'] };
    case 'negative_unresolved':
      return { sentiment: ['very_negative', 'negative'], status: ['new'] };
    case 'follow_up_required':
      return { followUpRequired: true };
    case 'unclassified':
      return { analysisStatus: ['pending', 'failed'] };
    case 'recently_resolved':
      return { status: ['reviewed'] };
    case 'positive_feedback':
      return { sentiment: ['very_positive', 'positive'] };
  }
}
