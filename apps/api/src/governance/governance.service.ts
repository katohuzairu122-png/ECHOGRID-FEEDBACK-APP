import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  auditLog, dropReservations, governanceCaseEvidence, governanceCases, governanceEvents, governanceOperators, governanceOverrides, shuffleEntries, shuffleSelectionResults,
} from '../db/schema';
import { AppError } from '../lib/errors';
import { canonicalJson, chainAudit, verifyChain, type AuditLink } from '../lib/audit-chain';
import { ShuffleParticipationService } from '../shuffle/shuffle-participation.service';
import { DropSponsorshipService } from '../drops/drop-sponsorship.service';

export type Actor = { actorUserId: string; ipAddress?: string | null; userAgent?: string | null };
export type Enabled = { shuffle: boolean; drops: boolean };
export type SubjectType = 'shuffle_campaign_version' | 'shuffle_entry' | 'shuffle_selection' | 'drop_sponsorship' | 'drop_reservation';
export type OverrideScope = 'cancel_entry_before_selection' | 'release_reserved_hold';
const conflict = (m: string, code: string) => new AppError(m, 409, code);
const bad = (m: string, code = 'VALIDATION_ERROR') => new AppError(m, 422, code);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const dbMessage = (e: unknown): string => { const x = e as { message?: string; cause?: { message?: string } }; return `${x?.message ?? ''} ${x?.cause?.message ?? ''}`; };

/** Translates the database's governance guards into typed outcomes (never a 500, never a silent success). */
function mapGuard(e: unknown): never {
  const m = dbMessage(e);
  if (m.includes('REVIEWER_NOT_ALLOWED')) throw new AppError('The reviewer must be an assigned operator for this kind of case and must not have opened it.', 403, 'OPERATOR_NOT_ASSIGNED');
  if (m.includes('DECIDER_NOT_ALLOWED') || m.includes('APPROVAL_NOT_ALLOWED')) throw new AppError('Separation of duties: a different, assigned operator is required.', 403, 'SEPARATION_OF_DUTIES');
  if (m.includes('OVERRIDE_NOT_ALLOWED')) throw new AppError('An override needs a case under review or decided, an assigned fraud investigator as requester and a future expiry.', 403, 'OVERRIDE_NOT_ALLOWED');
  if (m.includes('TRANSITION_NOT_ALLOWED')) throw conflict('That status change is not allowed from the current status.', 'TRANSITION_NOT_ALLOWED');
  if (m.includes('EVIDENCE_NOT_ALLOWED')) throw conflict('The case is closed; evidence can no longer be added.', 'CASE_CLOSED');
  if (m.includes('governance_overrides_open_target_uq')) throw conflict('An override for that target is already open.', 'OVERRIDE_ALREADY_OPEN');
  if (m.includes('REASON_REQUIRED')) throw bad('A reason of at least 10 characters is required.', 'REASON_REQUIRED');
  throw e;
}

/**
 * TSH-08 governance: fraud and dispute cases, append-only evidence, a hash-chained case log and TWO-PERSON overrides. Synthetic only. Disabled until the Owner
 * assigns operators (governance_operators is empty by default and has no write path here). No unrestricted administrator override exists: the ONLY scopes are
 * cancelling an entry BEFORE a selection and releasing a RESERVED hold. Voiding an allocation, replacing selected participants and rewriting selection evidence
 * have no scope. A decision records a finding and changes nothing by itself; any effect needs an approved, evidence-bound, expiring, single-use override.
 */
export class GovernanceService {
  constructor(private readonly db: Db, private readonly enabled: Enabled) {}

  private family(t: SubjectType): 'shuffle' | 'drops' { return t.startsWith('shuffle_') ? 'shuffle' : 'drops'; }
  private assertFamily(f: 'shuffle' | 'drops') { if (!this.enabled[f]) throw new AppError('Not found.', 404, 'NOT_FOUND'); }

  private async append(tx: Db, caseId: string, event: Record<string, unknown>, ctx: Actor) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'governance_chain:' + caseId}, 0))`);
    const [last] = await tx.select({ seq: governanceEvents.seq, hash: governanceEvents.hash }).from(governanceEvents).where(eq(governanceEvents.caseId, caseId)).orderBy(sql`seq desc`).limit(1);
    const link = chainAudit(last?.hash ?? null, event);
    await tx.insert(governanceEvents).values({ caseId, seq: (last?.seq ?? 0) + 1, prevHash: link.prev, hash: link.hash, event, actorUserId: ctx.actorUserId });
    await tx.insert(auditLog).values({ businessId: null, actorUserId: ctx.actorUserId, action: `governance.${String(event.type)}`, entityType: 'governance_case', entityId: caseId, metadata: { outcome: 'success', synthetic: true, ...event }, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null });
  }

  private async caseRow(tx: Db, id: string, lock = false) {
    const q = tx.select().from(governanceCases).where(eq(governanceCases.id, id)).limit(1);
    const [c] = lock ? await q.for('update') : await q;
    if (!c) throw new AppError('Case not found.', 404, 'CASE_NOT_FOUND');
    this.assertFamily(this.family(c.subjectType as SubjectType));
    return c;
  }

  /** Resolve the subject's campaign version or sponsorship server-side: the caller never supplies the related references. */
  private async resolve(tx: Db, type: SubjectType, id: string): Promise<{ campaignVersionId: string | null; sponsorshipId: string | null }> {
    if (type === 'shuffle_campaign_version') { const r = await tx.execute<{ id: string }>(sql`select id from shuffle_campaign_versions where id = ${id}`); if (!r.rows?.length) throw notFound(); return { campaignVersionId: id, sponsorshipId: null }; }
    if (type === 'shuffle_entry') { const [e] = await tx.select({ v: shuffleEntries.campaignVersionId }).from(shuffleEntries).where(eq(shuffleEntries.id, id)).limit(1); if (!e) throw notFound(); return { campaignVersionId: e.v, sponsorshipId: null }; }
    if (type === 'shuffle_selection') { const [e] = await tx.select({ v: shuffleSelectionResults.campaignVersionId }).from(shuffleSelectionResults).where(eq(shuffleSelectionResults.id, id)).limit(1); if (!e) throw notFound(); return { campaignVersionId: e.v, sponsorshipId: null }; }
    if (type === 'drop_sponsorship') { const r = await tx.execute<{ id: string }>(sql`select id from drop_sponsorships where id = ${id}`); if (!r.rows?.length) throw notFound(); return { campaignVersionId: null, sponsorshipId: id }; }
    const [e] = await tx.select({ s: dropReservations.sponsorshipId }).from(dropReservations).where(eq(dropReservations.id, id)).limit(1); if (!e) throw notFound(); return { campaignVersionId: null, sponsorshipId: e.s };
  }

  async openCase(input: { kind: 'fraud' | 'dispute'; subjectType: SubjectType; subjectId: string; classification: string; summary: string; relatedCaseId?: string | null | undefined }, ctx: Actor) {
    this.assertFamily(this.family(input.subjectType));
    if (!input.summary.trim() || input.summary.length > 1000) throw bad('The summary must be 1 to 1000 characters.');
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const refs = await this.resolve(db, input.subjectType, input.subjectId);
      try {
        const [c] = await tx.insert(governanceCases).values({ kind: input.kind, subjectType: input.subjectType, subjectId: input.subjectId, ...refs, classification: input.classification, summary: input.summary.trim(), relatedCaseId: input.relatedCaseId ?? null, openedByUserId: ctx.actorUserId }).returning();
        await this.append(db, c!.id, { type: 'opened', kind: input.kind, subjectType: input.subjectType, subjectId: input.subjectId, classification: input.classification }, ctx);
        return c!;
      } catch (e) { return mapGuard(e); }
    });
  }

  async submitEvidence(caseId: string, input: { kind: 'note' | 'reference'; body: string }, ctx: Actor) {
    const body = input.body.trim();
    if (!body || body.length > 2000) throw bad('Evidence must be 1 to 2000 characters.');
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; await this.caseRow(db, caseId);
      try {
        const [ev] = await tx.insert(governanceCaseEvidence).values({ caseId, submittedByUserId: ctx.actorUserId, kind: input.kind, body, contentHash: sha(canonicalJson({ kind: input.kind, body, by: ctx.actorUserId })) }).returning();
        await this.append(db, caseId, { type: 'evidence_submitted', evidenceId: ev!.id, contentHash: ev!.contentHash }, ctx);
        return ev!;
      } catch (e) { return mapGuard(e); }
    });
  }

  private async move(caseId: string, set: Record<string, unknown>, event: Record<string, unknown>, ctx: Actor, from: string[]) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; const c = await this.caseRow(db, caseId, true);
      if (!from.includes(c.status)) throw conflict('That status change is not allowed from the current status.', 'TRANSITION_NOT_ALLOWED');
      try {
        const [row] = await tx.update(governanceCases).set(set).where(eq(governanceCases.id, caseId)).returning();
        await this.append(db, caseId, event, ctx);
        return row!;
      } catch (e) { return mapGuard(e); }
    });
  }

  escalate(caseId: string, reason: string, ctx: Actor) { return this.move(caseId, { status: 'escalated', escalationReason: reason.trim() }, { type: 'escalated', reason: reason.trim() }, ctx, ['open']); }
  /** The acting operator becomes the reviewer (the database requires the assigned role for this kind of case and that they did not open it). */
  startReview(caseId: string, ctx: Actor) { return this.move(caseId, { status: 'under_review', reviewerUserId: ctx.actorUserId }, { type: 'review_started', reviewerUserId: ctx.actorUserId }, ctx, ['open', 'escalated']); }
  decide(caseId: string, decision: 'upheld' | 'overturned' | 'no_action', reason: string, ctx: Actor) {
    return this.move(caseId, { status: 'decided', decision, decisionReason: reason.trim(), decidedByUserId: ctx.actorUserId, decidedAt: new Date() }, { type: 'decided', decision, reason: reason.trim() }, ctx, ['under_review']);
  }
  close(caseId: string, ctx: Actor) { return this.move(caseId, { status: 'closed' }, { type: 'closed' }, ctx, ['decided']); }

  private async evidenceHash(tx: Db, caseId: string) {
    const rows = await tx.select({ h: governanceCaseEvidence.contentHash }).from(governanceCaseEvidence).where(eq(governanceCaseEvidence.caseId, caseId)).orderBy(asc(governanceCaseEvidence.createdAt), asc(governanceCaseEvidence.id));
    return sha(canonicalJson(rows.map((r) => r.h)));
  }

  private async isOperator(tx: Db, userId: string) {
    const [r] = await tx.select({ id: governanceOperators.id }).from(governanceOperators).where(and(eq(governanceOperators.userId, userId), eq(governanceOperators.active, true))).limit(1);
    return !!r;
  }

  /** Request a scoped override. The target must belong to the case's own campaign/sponsorship; the evidence set is hashed so approval cannot be given on stale evidence. */
  async requestOverride(caseId: string, input: { scope: OverrideScope; targetId: string; justification: string; expiresAt: Date }, ctx: Actor) {
    if (input.justification.trim().length < 10) throw bad('A justification of at least 10 characters is required.', 'REASON_REQUIRED');
    if (!(input.expiresAt.getTime() > Date.now())) throw bad('The override must expire in the future.', 'OVERRIDE_EXPIRY_INVALID');
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; const c = await this.caseRow(db, caseId, true);
      const fam = input.scope === 'cancel_entry_before_selection' ? 'shuffle' : 'drops';
      if (this.family(c.subjectType as SubjectType) !== fam) throw bad('That override scope does not apply to this case.', 'OVERRIDE_SCOPE_INVALID');
      if (fam === 'shuffle') { const [e] = await tx.select({ v: shuffleEntries.campaignVersionId }).from(shuffleEntries).where(eq(shuffleEntries.id, input.targetId)).limit(1); if (e?.v !== c.campaignVersionId) throw bad('The target is not part of the case campaign version.', 'OVERRIDE_TARGET_INVALID'); }
      else { const [e] = await tx.select({ s: dropReservations.sponsorshipId }).from(dropReservations).where(eq(dropReservations.id, input.targetId)).limit(1); if (e?.s !== c.sponsorshipId) throw bad('The target is not part of the case sponsorship.', 'OVERRIDE_TARGET_INVALID'); }
      try {
        const [o] = await tx.insert(governanceOverrides).values({ caseId, scope: input.scope, targetId: input.targetId, justification: input.justification.trim(), evidenceHash: await this.evidenceHash(db, caseId), requestedByUserId: ctx.actorUserId, expiresAt: input.expiresAt }).returning();
        await this.append(db, caseId, { type: 'override_requested', overrideId: o!.id, scope: input.scope, targetId: input.targetId }, ctx);
        return o!;
      } catch (e) { return mapGuard(e); }
    });
  }

  private async override(tx: Db, id: string) {
    const [o] = await tx.select().from(governanceOverrides).where(eq(governanceOverrides.id, id)).for('update').limit(1);
    if (!o) throw new AppError('Override not found.', 404, 'OVERRIDE_NOT_FOUND');
    await this.caseRow(tx, o.caseId);
    return o;
  }

  async approveOverride(id: string, ctx: Actor) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; const o = await this.override(db, id);
      if (o.status === 'approved') return o;
      if (o.status !== 'requested') throw conflict('Only a requested override can be approved.', 'TRANSITION_NOT_ALLOWED');
      if (o.evidenceHash !== (await this.evidenceHash(db, o.caseId))) throw conflict('The case evidence changed after the request; request again so the approver sees the current evidence.', 'OVERRIDE_EVIDENCE_STALE');
      try {
        const [row] = await tx.update(governanceOverrides).set({ status: 'approved', approvedByUserId: ctx.actorUserId }).where(eq(governanceOverrides.id, id)).returning();
        await this.append(db, o.caseId, { type: 'override_approved', overrideId: id }, ctx);
        return row!;
      } catch (e) { return mapGuard(e); }
    });
  }

  private async closeOut(id: string, to: 'rejected' | 'cancelled', reason: string, ctx: Actor) {
    if (reason.trim().length < 10) throw bad('A reason of at least 10 characters is required.', 'REASON_REQUIRED');
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; const o = await this.override(db, id);
      if (o.status === to) return o;
      if (!(await this.isOperator(db, ctx.actorUserId))) throw new AppError('An assigned operator is required.', 403, 'OPERATOR_NOT_ASSIGNED');
      try {
        const [row] = await tx.update(governanceOverrides).set({ status: to }).where(eq(governanceOverrides.id, id)).returning();
        await this.append(db, o.caseId, { type: `override_${to}`, overrideId: id, reason: reason.trim() }, ctx);
        return row!;
      } catch (e) { return mapGuard(e); }
    });
  }
  rejectOverride(id: string, reason: string, ctx: Actor) { return this.closeOut(id, 'rejected', reason, ctx); }
  cancelOverride(id: string, reason: string, ctx: Actor) { return this.closeOut(id, 'cancelled', reason, ctx); }

  /** Execute an APPROVED override atomically: the status change and the scoped action commit together or not at all. Single-use; expired approvals are refused. */
  async executeOverride(id: string, ctx: Actor) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; const o = await this.override(db, id);
      if (o.status === 'executed') return { override: o, created: false };
      if (o.status !== 'approved') throw conflict('Only an approved override can be executed.', 'TRANSITION_NOT_ALLOWED');
      if (!(await this.isOperator(db, ctx.actorUserId))) throw new AppError('An assigned operator is required.', 403, 'OPERATOR_NOT_ASSIGNED');
      if (o.evidenceHash !== (await this.evidenceHash(db, o.caseId))) throw conflict('The case evidence changed after the approval.', 'OVERRIDE_EVIDENCE_STALE');
      try {
        const [row] = await tx.update(governanceOverrides).set({ status: 'executed' }).where(eq(governanceOverrides.id, id)).returning();
        const reason = `override ${id}: ${o.justification}`;
        if (o.scope === 'cancel_entry_before_selection') await new ShuffleParticipationService(db).cancelEntryWithin(db, o.targetId, reason, ctx);
        else await new DropSponsorshipService(db).releaseWithin(db, o.targetId, reason, ctx);
        await this.append(db, o.caseId, { type: 'override_executed', overrideId: id, scope: o.scope, targetId: o.targetId }, ctx);
        return { override: row!, created: true };
      } catch (e) { return mapGuard(e); }
    });
  }

  async expireDue(caseId: string, ctx: Actor) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; await this.caseRow(db, caseId); let n = 0;
      const due = await tx.select().from(governanceOverrides).where(and(eq(governanceOverrides.caseId, caseId), sql`${governanceOverrides.status} IN ('requested','approved') AND ${governanceOverrides.expiresAt} <= now()`)).for('update');
      for (const o of due) { await tx.update(governanceOverrides).set({ status: 'expired' }).where(eq(governanceOverrides.id, o.id)); await this.append(db, caseId, { type: 'override_expired', overrideId: o.id }, ctx); n++; }
      return { expired: n };
    });
  }

  async getCase(caseId: string) {
    const c = await this.caseRow(this.db, caseId);
    const evidence = await this.db.select({ id: governanceCaseEvidence.id, kind: governanceCaseEvidence.kind, contentHash: governanceCaseEvidence.contentHash, submittedByUserId: governanceCaseEvidence.submittedByUserId, createdAt: governanceCaseEvidence.createdAt }).from(governanceCaseEvidence).where(eq(governanceCaseEvidence.caseId, caseId)).orderBy(asc(governanceCaseEvidence.createdAt));
    const overrides = await this.db.select({ id: governanceOverrides.id, scope: governanceOverrides.scope, status: governanceOverrides.status, expiresAt: governanceOverrides.expiresAt }).from(governanceOverrides).where(eq(governanceOverrides.caseId, caseId));
    return { case: c, evidence, overrides };
  }

  async verifyChain(caseId: string) {
    await this.caseRow(this.db, caseId);
    const links = await this.db.select().from(governanceEvents).where(eq(governanceEvents.caseId, caseId)).orderBy(asc(governanceEvents.seq));
    const chain: AuditLink[] = links.map((l) => ({ prev: l.prevHash, hash: l.hash, event: l.event }));
    return { events: links.length, chainOk: links.every((l, i) => l.seq === i + 1) && verifyChain(chain) };
  }
}
function notFound() { return new AppError('The subject was not found.', 404, 'SUBJECT_NOT_FOUND'); }
