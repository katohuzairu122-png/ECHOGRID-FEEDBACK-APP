import type { Repositories } from '../repositories';
import type { Feedback, NewFeedback } from '../repositories/feedback.repository';
import type { QrCode } from '../repositories/qr-code.repository';
import type { SubmitFeedbackInput, FeedbackFilterInput } from '@echo-grid-feedback/shared-types';
import { AppError } from '../lib/errors';
import { detectCriticalSignals } from './critical-detector';
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

    const created = await this.repos.feedback.create({
      businessId: qrCode.businessId,
      branchId: qrCode.branchId,
      qrCodeId: qrCode.id,
      ...input,
      // A follow-up answer only means something paired with the question it
      // answered -- never trust a client to keep these consistent.
      followUpAnswer: input.followUpQuestion ? input.followUpAnswer : undefined,
      urgency: detection.isCritical ? 'P0_CRITICAL' : undefined,
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

  async remove(id: string, businessId: string, deletedBy: string): Promise<void> {
    const existing = await this.repos.feedback.findById(id, businessId);
    if (!existing) {
      throw new AppError('Feedback not found.', 404, 'FEEDBACK_NOT_FOUND');
    }
    await this.repos.feedback.softDelete(id, businessId, deletedBy);
  }
}
