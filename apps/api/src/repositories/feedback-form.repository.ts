import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { feedbackAnswers, feedbackForms, feedbackFormVersions, feedbackQuestions, qrCodes } from '../db/schema';
import { BaseRepository } from './base.repository';
import type { CreateFeedbackFormInput, FeedbackAnswerInput, PublicFeedbackForm } from '@echo-grid-feedback/shared-types';
import { AppError } from '../lib/errors';

export class FeedbackFormRepository extends BaseRepository {
  async createPublished(businessId: string, actorId: string, input: CreateFeedbackFormInput): Promise<PublicFeedbackForm> {
    return this.db.transaction(async (tx) => {
      const [form] = await tx.insert(feedbackForms).values({ businessId, name: input.name, createdBy: actorId }).returning();
      if (!form) throw new Error('Form insert returned no row');
      const [version] = await tx.insert(feedbackFormVersions).values({ formId: form.id, version: 1 }).returning();
      if (!version) throw new Error('Version insert returned no row');
      const questions = await tx.insert(feedbackQuestions).values(input.questions.map((q, position) => ({
        versionId: version.id, key: q.key, label: q.label, type: q.type,
        required: q.required, position, options: q.options,
      }))).returning();
      return { formId: form.id, versionId: version.id, version: 1, name: form.name, questions } as PublicFeedbackForm;
    });
  }

  async createVersion(businessId: string, formId: string, input: CreateFeedbackFormInput): Promise<PublicFeedbackForm> {
    return this.db.transaction(async (tx) => {
      const form = await tx.query.feedbackForms.findFirst({ where: and(eq(feedbackForms.id, formId), eq(feedbackForms.businessId, businessId)) });
      if (!form) throw new AppError('Feedback form not found.', 404, 'FEEDBACK_FORM_NOT_FOUND');
      await tx.execute(sql`select id from ${feedbackForms} where ${feedbackForms.id} = ${formId} for update`);
      const [nextRow] = await tx.select({ next: sql<number>`coalesce(max(${feedbackFormVersions.version}), 0) + 1` }).from(feedbackFormVersions).where(eq(feedbackFormVersions.formId, formId));
      const [version] = await tx.insert(feedbackFormVersions).values({ formId, version: Number(nextRow?.next ?? 1) }).returning();
      if (!version) throw new Error('Version insert returned no row');
      const questions = await tx.insert(feedbackQuestions).values(input.questions.map((q, position) => ({ versionId: version.id, key: q.key, label: q.label, type: q.type, required: q.required, position, options: q.options }))).returning();
      return { formId, versionId: version.id, version: version.version, name: input.name, questions } as PublicFeedbackForm;
    });
  }

  async list(businessId: string): Promise<PublicFeedbackForm[]> {
    const forms = await this.db.query.feedbackForms.findMany({ where: eq(feedbackForms.businessId, businessId), orderBy: [desc(feedbackForms.createdAt)] });
    const result: PublicFeedbackForm[] = [];
    for (const form of forms) {
      const version = await this.db.query.feedbackFormVersions.findFirst({ where: eq(feedbackFormVersions.formId, form.id), orderBy: [desc(feedbackFormVersions.version)] });
      if (version) result.push((await this.hydrate(form.id, form.name, version.id, version.version))!);
    }
    return result;
  }

  async findPublishedVersion(versionId: string, businessId?: string): Promise<PublicFeedbackForm | undefined> {
    const version = await this.db.query.feedbackFormVersions.findFirst({ where: and(eq(feedbackFormVersions.id, versionId), eq(feedbackFormVersions.status, 'published')) });
    if (!version) return undefined;
    const form = await this.db.query.feedbackForms.findFirst({ where: and(eq(feedbackForms.id, version.formId), businessId ? eq(feedbackForms.businessId, businessId) : undefined) });
    return form ? this.hydrate(form.id, form.name, version.id, version.version) : undefined;
  }

  async findForQr(qrCodeId: string): Promise<PublicFeedbackForm | undefined> {
    const qr = await this.db.query.qrCodes.findFirst({ where: eq(qrCodes.id, qrCodeId) });
    return qr?.feedbackFormVersionId ? this.findPublishedVersion(qr.feedbackFormVersionId, qr.businessId) : undefined;
  }

  async assign(qrCodeId: string, businessId: string, versionId: string): Promise<void> {
    const version = await this.findPublishedVersion(versionId, businessId);
    if (!version) throw new AppError('Published feedback form version not found.', 404, 'FEEDBACK_FORM_NOT_FOUND');
    const [updated] = await this.db.update(qrCodes).set({ feedbackFormVersionId: versionId, updatedAt: new Date() }).where(and(eq(qrCodes.id, qrCodeId), eq(qrCodes.businessId, businessId))).returning({ id: qrCodes.id });
    if (!updated) throw new AppError('QR code not found.', 404, 'QR_CODE_NOT_FOUND');
  }

  async createAnswers(feedbackId: string, form: PublicFeedbackForm, answers: FeedbackAnswerInput[]): Promise<void> {
    if (!answers.length) return;
    const byId = new Map(form.questions.map((q) => [q.id, q]));
    await this.db.insert(feedbackAnswers).values(answers.map((answer) => {
      const q = byId.get(answer.questionId)!;
      return { feedbackId, questionId: q.id, questionKey: q.key, questionLabel: q.label, questionType: q.type, value: answer.value };
    }));
  }

  private async hydrate(formId: string, name: string, versionId: string, version: number): Promise<PublicFeedbackForm> {
    const questions = await this.db.query.feedbackQuestions.findMany({ where: eq(feedbackQuestions.versionId, versionId), orderBy: [asc(feedbackQuestions.position)] });
    return { formId, versionId, version, name, questions: questions.map((q) => ({ ...q, type: q.type as PublicFeedbackForm['questions'][number]['type'], options: q.options ?? null })) };
  }
}

