import type { Repositories } from '../repositories';
import type { Feedback, NewFeedback } from '../repositories/feedback.repository';
import type { QrCode } from '../repositories/qr-code.repository';
import type { SubmitFeedbackInput, FeedbackFilterInput } from '@echo-grid-feedback/shared-types';
import { AppError } from '../lib/errors';
import { detectCriticalSignals } from './critical-detector';
import { normalizeFeedbackText, hashNormalizedText } from './text-normalizer';
import { expandSavedView } from './feedback-saved-views';

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
    // plain hash-equality check, not fraud scoring: near-duplicate
    // detection, frequency limits, and any consequence beyond recording the
    // fact are Continuing Development Block 5 (S5.6), once the fraud-signal
    // schema exists. A
    // missing/empty comment never hashes -- there is no text to compare,
    // so it can never be flagged.
    const normalizedText = normalizeFeedbackText(input.comment);
    const normalizedTextHash = normalizedText ? await hashNormalizedText(normalizedText) : null;
    const priorMatch = normalizedTextHash
      ? await this.repos.feedback.findMostRecentByNormalizedHash(qrCode.businessId, qrCode.branchId, normalizedTextHash)
      : undefined;

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
      isDuplicateText: Boolean(priorMatch),
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
    patch: { category?: string; urgency?: string; sentiment?: string },
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
