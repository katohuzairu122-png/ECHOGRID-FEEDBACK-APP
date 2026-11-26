import { createHash } from 'node:crypto';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { dropFulfilmentPolicies, dropReservations, FULFILMENT_VERIFICATION_MODES } from '../db/schema';
import { AppError } from '../lib/errors';
import { canonicalJson } from '../lib/audit-chain';

export type Actor = { actorUserId: string };
const conflict = (m: string, code: string) => new AppError(m, 409, code);
const dbMessage = (e: unknown): string => { const x = e as { message?: string; cause?: { message?: string } }; return `${x?.message ?? ''} ${x?.cause?.message ?? ''}`; };
export type Unavailable = { available: false; reason: string };

const paramsSchema = z.object({ collectionVerification: z.enum(FULFILMENT_VERIFICATION_MODES), escalateAfterHours: z.number().positive().optional() }).strict();
const NO_POLICY: Unavailable = { available: false, reason: 'NO_APPROVED_FULFILMENT_POLICY' };

/**
 * G6 versioned fulfilment policy lifecycle and read-only policy interfaces (collection verification, escalation). Immutable versions, approval by a different person, one approved at a
 * time, runtime SELECT-only (authoring is Owner-side privileged tooling). NO SLA value exists in code: the escalation age is whatever an approved version supplies, and with no approved
 * policy every interface reports `available: false`. Nothing here fulfils, collects, expires or returns a unit.
 */
export class FulfilmentPolicyService {
  constructor(private readonly db: Db) {}

  async createDraft(input: { policyKey: string; parameters: unknown }, ctx: Actor) {
    const p = paramsSchema.safeParse(input.parameters);
    if (!p.success) throw new AppError('The policy parameters are not valid.', 422, 'POLICY_PARAMETERS_INVALID');
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(input.policyKey)) throw new AppError('Invalid policy key.', 422, 'VALIDATION_ERROR');
    const [last] = await this.db.select({ v: dropFulfilmentPolicies.version }).from(dropFulfilmentPolicies).where(eq(dropFulfilmentPolicies.policyKey, input.policyKey)).orderBy(desc(dropFulfilmentPolicies.version)).limit(1);
    const [row] = await this.db.insert(dropFulfilmentPolicies).values({ policyKey: input.policyKey, version: (last?.v ?? 0) + 1, parameters: p.data, parametersHash: createHash('sha256').update(canonicalJson(p.data)).digest('hex'), createdByUserId: ctx.actorUserId }).returning();
    return row!;
  }

  async approve(id: string, ctx: Actor) {
    try {
      const [row] = await this.db.update(dropFulfilmentPolicies).set({ approvalState: 'approved', approvedByUserId: ctx.actorUserId, approvedAt: new Date() }).where(and(eq(dropFulfilmentPolicies.id, id), eq(dropFulfilmentPolicies.approvalState, 'draft'))).returning();
      if (!row) throw conflict('Only a draft policy can be approved.', 'TRANSITION_NOT_ALLOWED');
      return row;
    } catch (e) {
      const m = dbMessage(e);
      if (m.includes('drop_fulfilment_policies_approval_shape')) throw new AppError('Separation of duties: a policy cannot be approved by its author.', 403, 'SEPARATION_OF_DUTIES');
      if (m.includes('drop_fulfilment_policies_one_approved_uq')) throw conflict('Another fulfilment policy is already approved; retire it first.', 'POLICY_ALREADY_APPROVED');
      throw e;
    }
  }

  async retire(id: string) {
    const [row] = await this.db.update(dropFulfilmentPolicies).set({ approvalState: 'retired', retiredAt: new Date() }).where(eq(dropFulfilmentPolicies.id, id)).returning();
    if (!row) throw new AppError('Policy not found.', 404, 'POLICY_NOT_FOUND');
    return row;
  }

  async effective() {
    const [row] = await this.db.select().from(dropFulfilmentPolicies).where(eq(dropFulfilmentPolicies.approvalState, 'approved')).limit(1);
    return row ?? null;
  }
  list() { return this.db.select().from(dropFulfilmentPolicies).orderBy(asc(dropFulfilmentPolicies.policyKey), asc(dropFulfilmentPolicies.version)); }

  /** Collection-policy interface: how a collection must be verified, or unavailable. */
  async collectionPolicy(): Promise<{ available: true; verification: string; policyVersionId: string } | Unavailable> {
    const p = await this.effective();
    return p ? { available: true, verification: String(p.parameters.collectionVerification), policyVersionId: p.id } : NO_POLICY;
  }

  /**
   * Escalation foundation (read-only, identity-free): allocated units still uncollected after the approved policy's escalation age. With no approved policy, or one that sets no
   * escalation age, the result is unavailable (never an empty "all clear"). Nothing is changed and nobody is contacted.
   */
  async escalations(sponsorshipId: string, now: Date = new Date()): Promise<{ available: true; policyVersionId: string; overdueUnits: number; reservationIds: string[] } | Unavailable> {
    const p = await this.effective();
    if (!p) return NO_POLICY;
    const hours = p.parameters.escalateAfterHours;
    if (typeof hours !== 'number') return { available: false, reason: 'POLICY_SETS_NO_ESCALATION_AGE' };
    const cutoff = new Date(now.getTime() - hours * 3_600_000);
    const rows = await this.db.select({ id: dropReservations.id }).from(dropReservations).where(and(eq(dropReservations.sponsorshipId, sponsorshipId), eq(dropReservations.status, 'allocated'), lt(dropReservations.statusChangedAt, cutoff))).orderBy(asc(dropReservations.id));
    return { available: true, policyVersionId: p.id, overdueUnits: rows.length, reservationIds: rows.map((r) => r.id) };
  }
}
