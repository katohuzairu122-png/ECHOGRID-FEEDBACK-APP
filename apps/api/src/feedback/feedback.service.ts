import type { Repositories } from '../repositories';
import type { Feedback, NewFeedback } from '../repositories/feedback.repository';
import type { QrCode } from '../repositories/qr-code.repository';
import type { SubmitFeedbackInput } from '@echo-grid-feedback/shared-types';
import { AppError } from '../lib/errors';
import { detectCriticalSignals } from './critical-detector';

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
