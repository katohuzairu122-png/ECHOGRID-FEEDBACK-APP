import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { businesses, businessClosureRequests, sponsorApplicationEvents, sponsorApplications } from '../db/schema';
import { AppError } from '../lib/errors';

export type Actor = { actorUserId: string };
const conflict = (m: string, code: string) => new AppError(m, 409, code);
const bad = (m: string, code = 'VALIDATION_ERROR') => new AppError(m, 422, code);
const dbMessage = (e: unknown): string => { const x = e as { message?: string; cause?: { message?: string } }; return `${x?.message ?? ''} ${x?.cause?.message ?? ''}`; };

function mapGuard(e: unknown): never {
  const m = dbMessage(e);
  if (m.includes('SEPARATION_OF_DUTIES')) throw new AppError('Separation of duties: an independent platform reviewer is required.', 403, 'SEPARATION_OF_DUTIES');
  if (m.includes('REASON_REQUIRED') || m.includes('a rejection needs a reason')) throw bad('A reason of at least 10 characters is required.', 'REASON_REQUIRED');
  if (m.includes('TRANSITION_NOT_ALLOWED')) throw conflict('That status change is not allowed from the current status.', 'TRANSITION_NOT_ALLOWED');
  if (m.includes('sponsor_applications_one_live_uq')) throw conflict('That business already has a live sponsor application.', 'APPLICATION_EXISTS');
  throw e;
}

/**
 * G6 sponsor onboarding: submit -> under_review -> approved | rejected, plus withdraw, suspend/reinstate and a final revoke. Every decision needs an independent platform administrator
 * (not the submitter); each step appends an audit event. SYNTHETIC ONLY (database CHECK): no real sponsor is approved by this block and there is no HTTP route here. The eligibility
 * assessment is recomputed on the server at submission and stored as evidence; it covers only facts the platform can verify (business active, no pending closure request).
 */
export class SponsorApplicationService {
  constructor(private readonly db: Db) {}

  async assess(businessId: string) {
    const [b] = await this.db.select({ status: businesses.status }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
    if (!b) throw new AppError('Business not found.', 404, 'BUSINESS_NOT_FOUND');
    const [pending] = await this.db.select({ id: businessClosureRequests.id }).from(businessClosureRequests).where(and(eq(businessClosureRequests.businessId, businessId), eq(businessClosureRequests.status, 'pending'))).limit(1);
    return { businessActive: b.status === 'active', noPendingClosureRequest: !pending };
  }

  private event(db: Db, applicationId: string, eventType: string, ctx: Actor, detail: Record<string, unknown>) {
    return db.insert(sponsorApplicationEvents).values({ applicationId, eventType, actorUserId: ctx.actorUserId, detail });
  }

  async submit(businessId: string, statement: string, ctx: Actor) {
    if (statement.trim().length < 1 || statement.length > 2000) throw bad('The statement must be 1 to 2000 characters.');
    const assessment = await this.assess(businessId);
    if (!assessment.businessActive || !assessment.noPendingClosureRequest) throw new AppError('The business is not eligible to apply.', 422, 'SPONSOR_NOT_ELIGIBLE');
    return this.db.transaction(async (tx) => {
      try {
        const [row] = await tx.insert(sponsorApplications).values({ businessId, submittedByUserId: ctx.actorUserId, statement: statement.trim(), eligibilityAssessment: assessment }).returning();
        await this.event(tx as unknown as Db, row!.id, 'submitted', ctx, { assessment });
        return row!;
      } catch (e) { return mapGuard(e); }
    });
  }

  private async move(id: string, to: string, set: Record<string, unknown>, from: string[], ctx: Actor, detail: Record<string, unknown> = {}) {
    return this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(sponsorApplications).where(eq(sponsorApplications.id, id)).for('update').limit(1);
      if (!cur) throw new AppError('Application not found.', 404, 'APPLICATION_NOT_FOUND');
      if (cur.status === to) return cur;
      if (!from.includes(cur.status)) throw conflict('That status change is not allowed from the current status.', 'TRANSITION_NOT_ALLOWED');
      try {
        const [row] = await tx.update(sponsorApplications).set({ status: to as never, ...set }).where(eq(sponsorApplications.id, id)).returning();
        await this.event(tx as unknown as Db, id, to, ctx, detail);
        return row!;
      } catch (e) { return mapGuard(e); }
    });
  }

  startReview(id: string, ctx: Actor) { return this.move(id, 'under_review', { reviewerUserId: ctx.actorUserId }, ['submitted'], ctx); }
  approve(id: string, ctx: Actor) { return this.move(id, 'approved', { decidedByUserId: ctx.actorUserId, decidedAt: new Date() }, ['under_review'], ctx); }
  reject(id: string, reason: string, ctx: Actor) { return this.move(id, 'rejected', { decidedByUserId: ctx.actorUserId, decidedAt: new Date(), statusReason: reason.trim() }, ['under_review'], ctx, { reason: reason.trim() }); }
  withdraw(id: string, ctx: Actor) { return this.move(id, 'withdrawn', {}, ['submitted', 'under_review'], ctx); }
  suspend(id: string, reason: string, ctx: Actor) { return this.move(id, 'suspended', { decidedByUserId: ctx.actorUserId, statusReason: reason.trim() }, ['approved'], ctx, { reason: reason.trim() }); }
  reinstate(id: string, reason: string, ctx: Actor) { return this.move(id, 'approved', { decidedByUserId: ctx.actorUserId, statusReason: reason.trim() }, ['suspended'], ctx, { reason: reason.trim() }); }
  revoke(id: string, reason: string, ctx: Actor) { return this.move(id, 'revoked', { decidedByUserId: ctx.actorUserId, statusReason: reason.trim() }, ['approved', 'suspended'], ctx, { reason: reason.trim() }); }

  /** True only while the business holds an APPROVED application (suspended and revoked sponsors are not approved). */
  async isApproved(businessId: string): Promise<boolean> {
    const r = await this.db.execute<{ ok: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM sponsor_applications WHERE business_id = ${businessId} AND status = 'approved') AS ok`);
    return r.rows[0]?.ok === true;
  }

  history(id: string) { return this.db.select().from(sponsorApplicationEvents).where(eq(sponsorApplicationEvents.applicationId, id)).orderBy(asc(sponsorApplicationEvents.createdAt)); }
}
