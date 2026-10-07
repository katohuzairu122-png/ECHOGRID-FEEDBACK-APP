import { and, desc, eq, sql } from 'drizzle-orm';
import {
  surveyAnswers,
  surveyParticipations,
} from '../db/schema';
import { BaseRepository } from './base.repository';

export type SurveyParticipation = typeof surveyParticipations.$inferSelect;
export type NewSurveyParticipation = typeof surveyParticipations.$inferInsert;
export type SurveyAnswer = typeof surveyAnswers.$inferSelect;
export type NewSurveyAnswer = typeof surveyAnswers.$inferInsert;

export class SurveyParticipationRepository extends BaseRepository {
  async findById(id: string): Promise<SurveyParticipation | undefined> {
    return this.db.query.surveyParticipations.findFirst({
      where: eq(surveyParticipations.id, id),
    });
  }

  async findByCampaignIdempotencyKey(
    campaignId: string,
    idempotencyKey: string,
  ): Promise<SurveyParticipation | undefined> {
    return this.db.query.surveyParticipations.findFirst({
      where: and(
        eq(surveyParticipations.campaignId, campaignId),
        eq(surveyParticipations.idempotencyKey, idempotencyKey),
      ),
    });
  }

  async createIdempotent(
    input: NewSurveyParticipation,
  ): Promise<{ participation: SurveyParticipation; inserted: boolean }> {
    const [inserted] = await this.db
      .insert(surveyParticipations)
      .values(input)
      .onConflictDoNothing({
        target: [surveyParticipations.campaignId, surveyParticipations.idempotencyKey],
      })
      .returning();

    if (inserted) return { participation: inserted, inserted: true };

    const existing = await this.findByCampaignIdempotencyKey(
      input.campaignId,
      input.idempotencyKey,
    );
    if (!existing) {
      throw new Error('Survey participation idempotency conflict did not resolve to an existing row.');
    }
    return { participation: existing, inserted: false };
  }

  async listForCustomer(customerId: string): Promise<SurveyParticipation[]> {
    return this.db.query.surveyParticipations.findMany({
      where: eq(surveyParticipations.participantCustomerId, customerId),
      orderBy: [desc(surveyParticipations.createdAt)],
    });
  }

  async countForCustomerCampaign(customerId: string, campaignId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(surveyParticipations)
      .where(
        and(
          eq(surveyParticipations.participantCustomerId, customerId),
          eq(surveyParticipations.campaignId, campaignId),
        ),
      );
    return Number(row?.count ?? 0);
  }

  async countCompletedForCampaign(campaignId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(surveyParticipations)
      .where(
        and(
          eq(surveyParticipations.campaignId, campaignId),
          eq(surveyParticipations.status, 'completed'),
        ),
      );
    return Number(row?.count ?? 0);
  }

  async listAnswers(participationId: string): Promise<SurveyAnswer[]> {
    return this.db.query.surveyAnswers.findMany({
      where: eq(surveyAnswers.participationId, participationId),
    });
  }

  async completeWithAnswers(
    participationId: string,
    answers: Omit<NewSurveyAnswer, 'participationId'>[],
    submissionPayloadHash: string,
    completedAt = new Date(),
  ): Promise<SurveyParticipation> {
    return this.db.transaction(async (tx) => {
      if (answers.length) {
        await tx
          .insert(surveyAnswers)
          .values(answers.map((answer) => ({ ...answer, participationId })));
      }

      const [updated] = await tx
        .update(surveyParticipations)
        .set({
          status: 'completed',
          submissionPayloadHash,
          submittedAt: completedAt,
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(surveyParticipations.id, participationId))
        .returning();

      if (!updated) throw new Error('Survey participation not found');
      return updated;
    });
  }

  async invalidate(id: string, invalidatedAt = new Date()): Promise<SurveyParticipation> {
    const [row] = await this.db
      .update(surveyParticipations)
      .set({
        status: 'invalidated',
        invalidatedAt,
        updatedAt: invalidatedAt,
      })
      .where(eq(surveyParticipations.id, id))
      .returning();

    if (!row) throw new Error('Survey participation not found');
    return row;
  }
}
