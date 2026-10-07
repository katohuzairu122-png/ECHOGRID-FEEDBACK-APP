import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import {
  surveyCampaigns,
  surveyQuestions,
  surveys,
  surveyVersions,
} from '../db/schema';
import { BaseRepository } from './base.repository';

export type Survey = typeof surveys.$inferSelect;
export type NewSurvey = typeof surveys.$inferInsert;
export type SurveyVersion = typeof surveyVersions.$inferSelect;
export type NewSurveyVersion = typeof surveyVersions.$inferInsert;
export type SurveyQuestion = typeof surveyQuestions.$inferSelect;
export type NewSurveyQuestion = typeof surveyQuestions.$inferInsert;
export type SurveyCampaign = typeof surveyCampaigns.$inferSelect;
export type NewSurveyCampaign = typeof surveyCampaigns.$inferInsert;

export class SurveyRepository extends BaseRepository {
  async createSurvey(input: NewSurvey): Promise<Survey> {
    const [row] = await this.db.insert(surveys).values(input).returning();
    if (!row) throw new Error('Survey insert returned no row');
    return row;
  }

  async findById(id: string): Promise<Survey | undefined> {
    return this.db.query.surveys.findFirst({ where: eq(surveys.id, id) });
  }

  async findBusinessOwnedById(id: string, businessId: string): Promise<Survey | undefined> {
    return this.db.query.surveys.findFirst({
      where: and(
        eq(surveys.id, id),
        eq(surveys.ownerType, 'business'),
        eq(surveys.businessId, businessId),
      ),
    });
  }

  async listForBusiness(businessId: string): Promise<Survey[]> {
    return this.db.query.surveys.findMany({
      where: and(eq(surveys.ownerType, 'business'), eq(surveys.businessId, businessId)),
      orderBy: [desc(surveys.createdAt)],
    });
  }

  async updateSurveyStatus(
    id: string,
    businessId: string,
    status: Survey['status'],
    updatedBy: string,
  ): Promise<Survey | undefined> {
    const [row] = await this.db
      .update(surveys)
      .set({ status, updatedBy, updatedAt: new Date() })
      .where(
        and(
          eq(surveys.id, id),
          eq(surveys.ownerType, 'business'),
          eq(surveys.businessId, businessId),
        ),
      )
      .returning();
    return row;
  }

  async createNextVersionWithQuestions(
    surveyId: string,
    versionInput: Omit<NewSurveyVersion, 'surveyId' | 'version'>,
    questions: Omit<NewSurveyQuestion, 'versionId'>[],
  ): Promise<{ version: SurveyVersion; questions: SurveyQuestion[] }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select id from ${surveys} where ${surveys.id} = ${surveyId} for update`);
      const [nextRow] = await tx
        .select({ next: sql<number>`coalesce(max(${surveyVersions.version}), 0) + 1` })
        .from(surveyVersions)
        .where(eq(surveyVersions.surveyId, surveyId));

      const [version] = await tx
        .insert(surveyVersions)
        .values({ ...versionInput, surveyId, version: Number(nextRow?.next ?? 1) })
        .returning();
      if (!version) throw new Error('Survey version insert returned no row');

      const insertedQuestions = questions.length
        ? await tx
            .insert(surveyQuestions)
            .values(questions.map((question) => ({ ...question, versionId: version.id })))
            .returning()
        : [];

      return { version, questions: insertedQuestions };
    });
  }

  async createVersionWithQuestions(
    versionInput: NewSurveyVersion,
    questions: Omit<NewSurveyQuestion, 'versionId'>[],
  ): Promise<{ version: SurveyVersion; questions: SurveyQuestion[] }> {
    return this.db.transaction(async (tx) => {
      const [version] = await tx.insert(surveyVersions).values(versionInput).returning();
      if (!version) throw new Error('Survey version insert returned no row');

      const insertedQuestions = questions.length
        ? await tx
            .insert(surveyQuestions)
            .values(questions.map((question) => ({ ...question, versionId: version.id })))
            .returning()
        : [];

      return { version, questions: insertedQuestions };
    });
  }

  async findVersionById(versionId: string): Promise<SurveyVersion | undefined> {
    return this.db.query.surveyVersions.findFirst({
      where: eq(surveyVersions.id, versionId),
    });
  }

  async publishVersionAndSurvey(
    versionId: string,
    surveyId: string,
    businessId: string,
    actorId: string,
    publishedAt = new Date(),
  ): Promise<SurveyVersion | undefined> {
    return this.db.transaction(async (tx) => {
      const [published] = await tx
        .update(surveyVersions)
        .set({ status: 'published', publishedAt })
        .where(and(eq(surveyVersions.id, versionId), eq(surveyVersions.surveyId, surveyId)))
        .returning();
      if (!published) return undefined;

      const [updatedSurvey] = await tx
        .update(surveys)
        .set({ status: 'published', updatedBy: actorId, updatedAt: publishedAt })
        .where(
          and(
            eq(surveys.id, surveyId),
            eq(surveys.ownerType, 'business'),
            eq(surveys.businessId, businessId),
          ),
        )
        .returning({ id: surveys.id });

      if (!updatedSurvey) {
        throw new Error('Survey disappeared during version publication.');
      }
      return published;
    });
  }

  async updateVersionStatus(
    versionId: string,
    surveyId: string,
    status: SurveyVersion['status'],
    publishedAt?: Date,
  ): Promise<SurveyVersion | undefined> {
    const [row] = await this.db
      .update(surveyVersions)
      .set({
        status,
        ...(publishedAt !== undefined ? { publishedAt } : {}),
      })
      .where(and(eq(surveyVersions.id, versionId), eq(surveyVersions.surveyId, surveyId)))
      .returning();
    return row;
  }

  async findVersionForBusiness(
    versionId: string,
    businessId: string,
  ): Promise<SurveyVersion | undefined> {
    const row = await this.db
      .select({ version: surveyVersions })
      .from(surveyVersions)
      .innerJoin(surveys, eq(surveys.id, surveyVersions.surveyId))
      .where(
        and(
          eq(surveyVersions.id, versionId),
          eq(surveys.ownerType, 'business'),
          eq(surveys.businessId, businessId),
        ),
      )
      .limit(1);
    return row[0]?.version;
  }

  async listQuestions(versionId: string): Promise<SurveyQuestion[]> {
    return this.db.query.surveyQuestions.findMany({
      where: eq(surveyQuestions.versionId, versionId),
      orderBy: [asc(surveyQuestions.position)],
    });
  }

  async createCampaign(input: NewSurveyCampaign): Promise<SurveyCampaign> {
    const [row] = await this.db.insert(surveyCampaigns).values(input).returning();
    if (!row) throw new Error('Survey campaign insert returned no row');
    return row;
  }

  async findCampaignById(id: string): Promise<SurveyCampaign | undefined> {
    return this.db.query.surveyCampaigns.findFirst({
      where: eq(surveyCampaigns.id, id),
    });
  }

  async findCampaignForBusiness(
    id: string,
    businessId: string,
  ): Promise<SurveyCampaign | undefined> {
    return this.db.query.surveyCampaigns.findFirst({
      where: and(eq(surveyCampaigns.id, id), eq(surveyCampaigns.businessId, businessId)),
    });
  }

  async listCampaignsForBusiness(businessId: string): Promise<SurveyCampaign[]> {
    return this.db.query.surveyCampaigns.findMany({
      where: eq(surveyCampaigns.businessId, businessId),
      orderBy: [desc(surveyCampaigns.createdAt)],
    });
  }

  async listQrExposedForBusinessBranch(
    businessId: string,
    branchId: string,
  ): Promise<SurveyCampaign[]> {
    return this.db.query.surveyCampaigns.findMany({
      where: and(
        eq(surveyCampaigns.businessId, businessId),
        eq(surveyCampaigns.status, 'active'),
        eq(surveyCampaigns.exposeInQrResolver, true),
        or(
          isNull(surveyCampaigns.branchId),
          eq(surveyCampaigns.branchId, branchId),
        ),
      ),
      orderBy: [desc(surveyCampaigns.createdAt)],
    });
  }

  async updateCampaignStatus(
    id: string,
    businessId: string,
    status: SurveyCampaign['status'],
    updatedBy: string,
  ): Promise<SurveyCampaign | undefined> {
    const [row] = await this.db
      .update(surveyCampaigns)
      .set({ status, updatedBy, updatedAt: new Date() })
      .where(and(eq(surveyCampaigns.id, id), eq(surveyCampaigns.businessId, businessId)))
      .returning();
    return row;
  }
}
