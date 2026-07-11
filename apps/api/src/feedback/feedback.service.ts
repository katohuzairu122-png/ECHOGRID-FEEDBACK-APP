import type { Repositories } from '../repositories';
import type { Feedback, NewFeedback } from '../repositories/feedback.repository';
import type { QrCode } from '../repositories/qr-code.repository';
import type { SubmitFeedbackInput } from '@echo-grid-feedback/shared-types';
import { AppError } from '../lib/errors';

export class FeedbackService {
  constructor(private readonly repos: Pick<Repositories, 'feedback'>) {}

  async listForBusiness(
    businessId: string,
    options: { branchId?: string; limit?: number; offset?: number } = {},
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
    return this.repos.feedback.create({
      businessId: qrCode.businessId,
      branchId: qrCode.branchId,
      qrCodeId: qrCode.id,
      ...input,
    } satisfies NewFeedback);
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
