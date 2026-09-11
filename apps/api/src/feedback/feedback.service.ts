import type { Repositories } from '../repositories';
import type { Feedback, NewFeedback } from '../repositories/feedback.repository';
import type { QrCode } from '../repositories/qr-code.repository';
import type {
  SubmitFeedbackInput,
  FeedbackFilterInput,
  ClassifyFeedbackInput,
} from '@echo-grid-feedback/shared-types';
import { AppError } from '../lib/errors';
import { detectCriticalSignals } from './critical-detector';
import { normalizeFeedbackText, hashNormalizedText, isDistinctiveEnoughToCompare } from './text-normalizer';
import { expandSavedView } from './feedback-saved-views';

/**
 * Continuing Development S5-A. Window for the duplicate-text frequency count
 * (spec S5.6). Bounded rather than all-time so the number means "how often
 * recently", not "how long has this business been a customer" -- see
 * FeedbackRepository.countByNormalizedHash on why the window is mandatory.
 *
 * 30 days is wide enough to catch a templated campaign that paces itself to
 * stay under the 10-minute device/IP velocity limits
 * (fraud/velocity-tracker.ts), and narrow enough that a phrase a regular
 * genuinely reuses across seasons does not accumulate forever.
 */
const DUPLICATE_LOOKBACK_DAYS = 30;
const DUPLICATE_LOOKBACK_MS = DUPLICATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

export class FeedbackService {
  constructor(private readonly repos: Pick<Repositories, 'feedback' | 'criticalIncidents'>) {}

  async listForBusiness(
    businessId: string,
    options: { branchId?: string | undefined; limit?: number | undefined; offset?: number | undefined } = {},
  ): Promise<Feedback[]> {
    return this.repos.feedback.listForBusiness(businessId, options);
  }

  /**
   * The write side of the public, anonymous submission flow. Caller
   * (qr.routes.ts) has already resolved the token to a QrCode via
   * QrCodeService.resolveToken() -- this method takes no businessId/actor
   * because there isn't one; the qrCode itself is what authorizes the
   * write and supplies the tenant scoping.
   */
  async submit(qrCode: QrCode, input: SubmitFeedbackInput): Promise<Feedback> {
    // Level 1 deterministic processing (Automated Feedback Sorting) -- a
    // synchronous keyword scan, never a model call, so a credible safety
    // emergency gets P0_CRITICAL the instant this row is stored, not
    // whenever Level 2's async AI classification happens to run. Comment
    // only: a bare low rating with no text is never itself an emergency
    // signal (see critical-detector.ts).
    const detection = detectCriticalSignals(input.comment);

    // Level 1 deterministic processing, continued -- exact-duplicate text
    // detection (spec S3.1/S9.1). See text-normalizer.ts for why this is a
    // plain hash-equality check, not fraud scoring: near-duplicate scoring
    // and any CONSEQUENCE beyond recording the fact (fraud reason codes,
    // manual-review routing, reward blocking) remain S5-B/S5-C. Frequency is
    // now recorded here rather than deferred -- see duplicateTextCount below.
    // A missing/empty comment never hashes -- there is no text to compare,
    // so it can never be flagged. Recording only, never rejecting
    // (S2.9/S2.15: never lose real customer feedback).
    // S5-A: the distinctiveness floor gates HASHING, not just flagging, so a
    // short common phrase leaves no hash behind for anything downstream to
    // misread as a duplicate. See text-normalizer.ts's MIN_DISTINCTIVE_LENGTH
    // for why "Great service!" must not collide with the next customer who
    // writes it.
    const normalizedText = normalizeFeedbackText(input.comment);
    const normalizedTextHash = isDistinctiveEnoughToCompare(normalizedText)
      ? await hashNormalizedText(normalizedText)
      : null;

    // Counted, not merely detected (spec S5.6 "frequency checks"): one repeat
    // is unremarkable and thirty is a template, and S5-B's fraud-signal
    // routing needs to tell those apart. Costs the same single indexed query
    // the previous existence lookup did.
    const duplicateTextCount = normalizedTextHash
      ? await this.repos.feedback.countByNormalizedHash(
          qrCode.businessId,
          qrCode.branchId,
          normalizedTextHash,
          new Date(Date.now() - DUPLICATE_LOOKBACK_MS),
        )
      : 0;

    const created = await this.repos.feedback.create({
      businessId: qrCode.businessId,
      branchId: qrCode.branchId,
      qrCodeId: qrCode.id,
      ...input,
      // A follow-up answer only means something paired with the question it
      // answered -- never trust a client to keep these consistent.
      followUpAnswer: input.followUpQuestion ? input.followUpAnswer : undefined,
      urgency: detection.isCritical ? 'P0_CRITICAL' : undefined,
      normalizedTextHash: normalizedTextHash ?? undefined,
      isDuplicateText: duplicateTextCount > 0,
      duplicateTextCount,
    } satisfies NewFeedback);

    // Not transaction-wrapped with the insert above (this service stays
    // Repositories-shaped, not Database-shaped, so its unit tests can keep
    // using the fake in-memory repo convention -- see feedback.service.test.ts).
    // Both statements run synchronously in the same request with nothing
    // async in between, so the crash window this leaves open is narrow; the
    // critical-escalation sweep (critical-alerts.job.ts) additionally
    // backstops it by re-scanning for P0_CRITICAL feedback with no incident
    // row, so a gap here is self-healing, not silent data loss.
    if (detection.isCritical) {
      await this.repos.criticalIncidents.create({
        businessId: qrCode.businessId,
        branchId: qrCode.branchId,
        feedbackId: created.id,
        matchedSignals: detection.matchedSignals.join(', '),
      });
    }

    return created;
  }

  /** Merges a named saved view's preset fields with the caller's own
   * explicit filters -- the caller's values win wherever both set the same
   * field (e.g. requesting "Critical now" narrowed to one branchId), never
   * the other way around. See feedback-saved-views.ts's own doc comment for
   * why only 7 of the spec's 11 named views are representable today. */
  async listWithFilters(
    businessId: string,
    input: FeedbackFilterInput,
  ): Promise<{ items: Feedback[]; hasMore: boolean }> {
    const { savedView, ...explicit } = input;
    const preset = savedView ? expandSavedView(savedView) : {};

    const merged: Omit<FeedbackFilterInput, 'savedView'> = {
      ...preset,
      ...explicit,
      urgency: explicit.urgency ?? preset.urgency,
      status: explicit.status ?? preset.status,
      sentiment: explicit.sentiment ?? preset.sentiment,
      analysisStatus: explicit.analysisStatus ?? preset.analysisStatus,
      followUpRequired: explicit.followUpRequired ?? preset.followUpRequired,
    };

    return this.repos.feedback.listWithFilters(businessId, merged);
  }

  async assign(id: string, businessId: string, assignedTo: string | null, updatedBy: string): Promise<Feedback> {
    const updated = await this.repos.feedback.assign(id, businessId, assignedTo, updatedBy);
    if (!updated) {
      throw new AppError('Feedback not found.', 404, 'FEEDBACK_NOT_FOUND');
    }
    return updated;
  }

  /** Returns exactly which of the requested ids were actually updated --
   * a caller who selected 20 rows in the inbox and one was deleted by
   * another tab in the meantime should see 19 succeeded, not a silent
   * partial success or an all-or-nothing failure. */
  async bulkAssign(
    ids: string[],
    businessId: string,
    assignedTo: string | null,
    updatedBy: string,
  ): Promise<Feedback[]> {
    return this.repos.feedback.bulkAssign(ids, businessId, assignedTo, updatedBy);
  }

  async bulkMarkReviewed(ids: string[], businessId: string, updatedBy: string): Promise<Feedback[]> {
    return this.repos.feedback.bulkMarkReviewed(ids, businessId, updatedBy);
  }

  async markReviewed(id: string, businessId: string, updatedBy: string): Promise<Feedback> {
    const updated = await this.repos.feedback.markReviewed(id, businessId, updatedBy);
    if (!updated) {
      throw new AppError('Feedback not found.', 404, 'FEEDBACK_NOT_FOUND');
    }
    return updated;
  }

  /**
   * Continuing Development S4 Block 10 (S4.3 "allow authorized manual
   * classification"). Applies a human's classification and moves the row to
   * the terminal 'manual' analysis state.
   *
   * Rejects a patch with no fields set rather than treating it as a
   * successful no-op: an empty body almost always means a client bug or a
   * mis-built form, and silently answering 200 while flipping the row to
   * 'manual' would mark it handled without anyone having actually
   * classified it -- the row then leaves the "Unclassified" saved view with
   * every field still null, which is worse than the stuck row it replaced.
   *
   * Every field stays independently optional above that floor: correcting
   * only the urgency on an otherwise well-classified row is a normal
   * action, and forcing the caller to re-send category and sentiment
   * unchanged would invite them to overwrite good values with stale ones
   * read from a page they opened minutes ago.
   */
  async classifyManually(
    id: string,
    businessId: string,
    patch: ClassifyFeedbackInput,
    updatedBy: string,
  ): Promise<Feedback> {
    if (patch.category === undefined && patch.urgency === undefined && patch.sentiment === undefined) {
      throw new AppError(
        'Provide at least one of category, urgency or sentiment.',
        400,
        'EMPTY_CLASSIFICATION',
      );
    }

    const updated = await this.repos.feedback.classifyManually(id, businessId, patch, updatedBy);
    if (!updated) {
      throw new AppError('Feedback not found.', 404, 'FEEDBACK_NOT_FOUND');
    }
    return updated;
  }

  async remove(id: string, businessId: string, deletedBy: string): Promise<void> {
    const existing = await this.repos.feedback.findById(id, businessId);
    if (!existing) {
      throw new AppError('Feedback not found.', 404, 'FEEDBACK_NOT_FOUND');
    }
    await this.repos.feedback.softDelete(id, businessId, deletedBy);
  }
}
