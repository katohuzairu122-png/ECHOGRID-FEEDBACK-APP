import { createHash } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { GOVERNANCE_DECISIONS, GOVERNANCE_OVERRIDE_SCOPES, GOVERNANCE_POLICY_FAMILIES, GOVERNANCE_POLICY_KINDS, governanceDecisionPolicies } from '../db/schema';
import { AppError } from '../lib/errors';
import { canonicalJson } from '../lib/audit-chain';

export type Actor = { actorUserId: string };
export type PolicyKind = (typeof GOVERNANCE_POLICY_KINDS)[number];
export type PolicyFamily = (typeof GOVERNANCE_POLICY_FAMILIES)[number];
const conflict = (m: string, code: string) => new AppError(m, 409, code);
const dbMessage = (e: unknown): string => { const x = e as { message?: string; cause?: { message?: string } }; return `${x?.message ?? ''} ${x?.cause?.message ?? ''}`; };

/** STRUCTURAL parameters only. No fraud threshold, dispute SLA or customer penalty exists here: those are Owner policy values that are not invented in code. */
const decisionParams = z.object({
  allowedDecisions: z.array(z.enum(GOVERNANCE_DECISIONS)).min(1), minEvidenceItems: z.number().int().min(0).max(50),
}).strict();
const overrideParams = z.object({
  allowedScopes: z.array(z.enum(GOVERNANCE_OVERRIDE_SCOPES)).min(1), maxExpirySeconds: z.number().int().positive().optional(),
}).strict();

/**
 * G5 decision-policy lifecycle: draft -> approved (by a DIFFERENT person) -> retired, immutable per version. The runtime role can only read policies (SELECT); authoring and approval
 * are Owner-side privileged operations (no HTTP route), exactly like operator assignment. A policy version is never edited: a change is a new version.
 */
export class GovernanceDecisionPolicyService {
  constructor(private readonly db: Db) {}

  static validate(kind: PolicyKind, parameters: unknown): Record<string, unknown> {
    const r = (kind === 'override' ? overrideParams : decisionParams).safeParse(parameters);
    if (!r.success) throw new AppError('The policy parameters are not valid for this kind.', 422, 'POLICY_PARAMETERS_INVALID');
    return r.data as Record<string, unknown>;
  }

  async createDraft(input: { policyKey: string; kind: PolicyKind; subjectFamily: PolicyFamily; parameters: unknown }, ctx: Actor) {
    const parameters = GovernanceDecisionPolicyService.validate(input.kind, input.parameters);
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(input.policyKey)) throw new AppError('Invalid policy key.', 422, 'VALIDATION_ERROR');
    const [last] = await this.db.select({ v: governanceDecisionPolicies.version }).from(governanceDecisionPolicies).where(eq(governanceDecisionPolicies.policyKey, input.policyKey)).orderBy(desc(governanceDecisionPolicies.version)).limit(1);
    const [row] = await this.db.insert(governanceDecisionPolicies).values({
      policyKey: input.policyKey, version: (last?.v ?? 0) + 1, kind: input.kind, subjectFamily: input.subjectFamily, parameters,
      parametersHash: createHash('sha256').update(canonicalJson(parameters)).digest('hex'), createdByUserId: ctx.actorUserId,
    }).returning();
    return row!;
  }

  /** Approval requires a different person from the author (database CHECK); at most one approved policy per kind and subject family (partial unique index). */
  async approve(id: string, ctx: Actor) {
    try {
      const [row] = await this.db.update(governanceDecisionPolicies).set({ approvalState: 'approved', approvedByUserId: ctx.actorUserId, approvedAt: new Date() })
        .where(and(eq(governanceDecisionPolicies.id, id), eq(governanceDecisionPolicies.approvalState, 'draft'))).returning();
      if (!row) throw conflict('Only a draft policy can be approved.', 'TRANSITION_NOT_ALLOWED');
      return row;
    } catch (e) {
      const m = dbMessage(e);
      if (m.includes('governance_decision_policies_approval_shape')) throw new AppError('Separation of duties: a policy cannot be approved by its author.', 403, 'SEPARATION_OF_DUTIES');
      if (m.includes('governance_decision_policies_one_approved_uq')) throw conflict('Another policy is already approved for this kind and subject family; retire it first.', 'POLICY_ALREADY_APPROVED');
      throw e;
    }
  }

  async retire(id: string) {
    const [row] = await this.db.update(governanceDecisionPolicies).set({ approvalState: 'retired', retiredAt: new Date() }).where(eq(governanceDecisionPolicies.id, id)).returning();
    if (!row) throw new AppError('Policy not found.', 404, 'POLICY_NOT_FOUND');
    return row;
  }

  /** The single approved policy that governs a kind and subject family, or null (which blocks the decision). */
  async effectiveFor(kind: PolicyKind, subjectFamily: PolicyFamily) {
    const [row] = await this.db.select().from(governanceDecisionPolicies).where(and(eq(governanceDecisionPolicies.kind, kind), eq(governanceDecisionPolicies.subjectFamily, subjectFamily), eq(governanceDecisionPolicies.approvalState, 'approved'))).limit(1);
    return row ?? null;
  }

  list() { return this.db.select().from(governanceDecisionPolicies).orderBy(asc(governanceDecisionPolicies.policyKey), asc(governanceDecisionPolicies.version)); }
}
