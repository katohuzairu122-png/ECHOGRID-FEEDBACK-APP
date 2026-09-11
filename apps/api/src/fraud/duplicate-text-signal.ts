/**
 * Continuing Development S5-B (spec S5.6's "fraud reason codes and
 * manual-review routing"). Turns S5-A's `feedback.duplicateTextCount` into a
 * decision: does this submission warrant a human looking at it, and how
 * loudly.
 *
 * Lives in fraud/ rather than feedback/ deliberately. feedback/text-
 * normalizer.ts owns the MECHANICS of deciding whether two comments are the
 * same text; this file owns the POLICY of what repetition means, which is a
 * fraud judgment and belongs beside velocity-tracker.ts's thresholds. The
 * split is the same one that keeps the distinctiveness floor out of
 * `normalize` -- see text-normalizer.ts's own note.
 *
 * Signal-only, never blocking: nothing here rejects a submission or
 * withholds anything. Same precedent as the cooldown and visit-verification
 * detectors in qr.routes.ts, and required by S2.9/S2.15 ("never lose real
 * customer feedback"). A duplicate is evidence for a reviewer, not a verdict.
 */

export type FraudSeverity = 'low' | 'medium' | 'high';

/**
 * Prior identical submissions required before a signal is raised. Two, so the
 * THIRD copy is the first one a human hears about.
 *
 * One repeat is genuinely unremarkable on a mobile QR flow: a customer taps
 * submit, the connection stalls, they tap again. Flagging that would fill the
 * review queue with the platform's own network behaviour, and a queue that
 * cries wolf is worse than no queue -- reviewers learn to dismiss it, and the
 * real template slips through with everything else.
 *
 * A third identical comment at one branch is a pattern rather than an
 * accident, and is still cheap to dismiss if innocent.
 */
export const DUPLICATE_SIGNAL_THRESHOLD = 2;

/** Escalation bands, by prior-copy count. Deliberately coarse -- a reviewer
 * needs "glance at this eventually" vs "look now", not a continuous score
 * they have to interpret. Tunable from real data; these are reasoned
 * defaults, not measured ones. */
const MEDIUM_SEVERITY_AT = 5;
const HIGH_SEVERITY_AT = 10;

export function shouldRaiseDuplicateTextSignal(duplicateTextCount: number): boolean {
  return duplicateTextCount >= DUPLICATE_SIGNAL_THRESHOLD;
}

/**
 * Severity is driven by the count and nothing else. Not by rating, sentiment
 * or urgency: a flood of identical five-star praise is exactly as suspicious
 * as a flood of identical complaints, and arguably more commercially
 * damaging, so letting a positive rating soften the severity would build the
 * wrong bias straight into the fraud queue.
 */
export function duplicateTextSeverity(duplicateTextCount: number): FraudSeverity {
  if (duplicateTextCount >= HIGH_SEVERITY_AT) return 'high';
  if (duplicateTextCount >= MEDIUM_SEVERITY_AT) return 'medium';
  return 'low';
}

export const DUPLICATE_TEXT_SIGNAL_TYPE = 'duplicate_text';
export const DUPLICATE_TEXT_REASON_CODE = 'repeated_exact_text';
