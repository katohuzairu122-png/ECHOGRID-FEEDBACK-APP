import type { Repositories } from '../repositories';
import type { Feedback } from '../repositories/feedback.repository';
import { AppError } from '../lib/errors';
import { SentimentClassifier } from './sentiment-classifier';
import { classifyCategory, classifyUrgency } from '../feedback/feedback-classifier';

/**
 * Orchestrates one feedback row's classification -- called from the queue
 * consumer (index.ts) for the normal async path, and from the manual
 * reanalyze endpoint (feedback.routes.ts) for staff-triggered retries.
 */
export class SentimentService {
  constructor(
    private readonly repos: Pick<Repositories, 'feedback'>,
    private readonly classifier: SentimentClassifier,
  ) {}

  /**
   * At-least-once queue delivery means this can run more than once for the
   * same row -- deliberately idempotent by just overwriting sentiment
   * fields with the freshly computed result rather than checking
   * analysisStatus first, so a duplicate delivery is harmless instead of
   * something the caller needs to guard against.
   */
  async classifyAndStore(feedbackId: string, businessId: string): Promise<Feedback> {
    const feedback = await this.repos.feedback.findById(feedbackId, businessId);
    if (!feedback) {
      throw new AppError('Feedback not found.', 404, 'FEEDBACK_NOT_FOUND');
    }

    try {
      // A comment gets a real AI classification; a rating-only submission
      // (comment is optional, see feedback.ts) gets the deterministic
      // rating-based fallback instead of spending an inference on nothing.
      const result = feedback.comment?.trim()
        ? await this.classifier.classifyText(feedback.comment.trim())
        : this.classifier.classifyRating(feedback.rating);

      // Automated Feedback Sorting Level 2 -- category always gets
      // (re)computed here; urgency does NOT if Level 1 (critical-detector.ts)
      // already stamped this row P0_CRITICAL at submission time. That flag
      // is a synchronous, human-safety-relevant judgment made the instant
      // the row was stored -- this async pass running later, on the same
      // comment text, must never silently downgrade it back to P1-P3.
      const category = classifyCategory(feedback.comment, feedback.rating);
      const urgency =
        feedback.urgency === 'P0_CRITICAL'
          ? feedback.urgency
          : classifyUrgency(feedback.rating, result.sentiment, category);

      const updated = await this.repos.feedback.updateSentiment(feedbackId, businessId, {
        sentiment: result.sentiment,
        sentimentScore: result.score,
        analysisStatus: 'completed',
        analyzedAt: new Date(),
        category,
        urgency,
      });
      if (!updated) throw new AppError('Feedback not found.', 404, 'FEEDBACK_NOT_FOUND');
      return updated;
    } catch (err) {
      // A classifier failure (Workers AI unavailable, unexpected response
      // shape) marks the row 'failed' instead of leaving it silently stuck
      // at 'pending' forever or crashing the queue consumer -- 'failed' rows
      // are what the backfill sweep and the analytics dashboard's status
      // filter (Block 4) both surface for visibility/retry.
      await this.repos.feedback.updateSentiment(feedbackId, businessId, {
        analysisStatus: 'failed',
        analyzedAt: new Date(),
      });
      throw err;
    }
  }
}

/** Convenience factory so callers don't need to import SentimentClassifier separately. */
export function createSentimentService(repos: Pick<Repositories, 'feedback'>, ai: Ai): SentimentService {
  return new SentimentService(repos, new SentimentClassifier(ai));
}
