import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  orphanSettlements, partnerCreditAwardDecisions, partnerCreditAwardDisputes, partnerCreditCorrections, partnerCreditDisputeEvents, users,
} from '../db/schema';

/**
 * Split 07 disputed-award HOLD overlay service (migration 0050, INERT). The frozen award state machine is not touched: a dispute is a separate record,
 * and while it is `open` (or `revoked` and not yet executed) the award is HELD, which the lifecycle and reservation services enforce through
 * `hasActiveDisputeHold`. Authorization: only an ACTIVE platform administrator may open, evidence, propose, decide or resolve (the same authority Split 06
 * requires to reverse a settlement); the acting role is snapshotted on every event. A revocation is financial-impacting, so it needs dual control: one
 * administrator proposes, a DIFFERENT one approves (the database refuses self-approval as well), and the result is a recorded PLAN only. No ledger entry,
 * lot, account or award is written here; executing a revocation is a separate, unauthorized financial stage.
 *
 * Lock order matches the rest of Split 06/07: settlement, then award decision, then the dispute rows.
 */
export type DisputeErrorCode =
  | 'ACTOR_NOT_AUTHORIZED' | 'DECISION_NOT_FOUND' | 'AWARD_NOT_DISPUTABLE' | 'DISPUTE_NOT_FOUND' | 'DISPUTE_ALREADY_OPEN' | 'DISPUTE_NOT_OPEN'
  | 'INVALID_INPUT' | 'CORRECTION_NOT_FOUND' | 'CORRECTION_ALREADY_EXISTS' | 'CORRECTION_NOT_PROPOSED' | 'SELF_APPROVAL' | 'DUAL_APPROVAL_REQUIRED' | 'CORRECTION_PENDING';

export class DisputeError extends Error {
  constructor(public readonly code: DisputeErrorCode) {
    super(`Partner credit dispute: ${code}`);
    this.name = 'DisputeError';
  }
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Reader = Pick<Database, 'select'>;

/** True while an unresolved (`open`) or approved-but-unexecuted (`revoked`) dispute exists for the award. Read-only; safe inside any transaction. */
export async function hasActiveDisputeHold(db: Reader | Tx, decisionId: string): Promise<boolean> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(partnerCreditAwardDisputes)
    .where(and(eq(partnerCreditAwardDisputes.decisionId, decisionId), inArray(partnerCreditAwardDisputes.state, ['open', 'revoked'])));
  return (row?.n ?? 0) > 0;
}

const text = (s: unknown, max = 1000): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= max;

async function requireAdmin(tx: Tx, actorId: string): Promise<void> {
  const [u] = await tx.select({ status: users.status, platformRole: users.platformRole }).from(users).where(eq(users.id, actorId));
  if (!u || u.status !== 'active' || u.platformRole !== 'admin') throw new DisputeError('ACTOR_NOT_AUTHORIZED');
}

export class PartnerCreditDisputeService {
  constructor(private readonly db: Database) {}

  /** Locks settlement then decision, validating that the award exists and is still disputable. */
  private async lockDecision(tx: Tx, decisionId: string) {
    const [ref] = await tx.select({ settlementRef: partnerCreditAwardDecisions.settlementRef }).from(partnerCreditAwardDecisions).where(eq(partnerCreditAwardDecisions.id, decisionId));
    if (!ref) throw new DisputeError('DECISION_NOT_FOUND');
    await tx.select({ id: orphanSettlements.id }).from(orphanSettlements).where(eq(orphanSettlements.id, ref.settlementRef)).for('update');
    const [decision] = await tx.select().from(partnerCreditAwardDecisions).where(eq(partnerCreditAwardDecisions.id, decisionId)).for('update');
    if (!decision) throw new DisputeError('DECISION_NOT_FOUND');
    return decision;
  }

  private async lockDispute(tx: Tx, disputeId: string) {
    const [ref] = await tx.select({ decisionId: partnerCreditAwardDisputes.decisionId }).from(partnerCreditAwardDisputes).where(eq(partnerCreditAwardDisputes.id, disputeId));
    if (!ref) throw new DisputeError('DISPUTE_NOT_FOUND');
    const decision = await this.lockDecision(tx, ref.decisionId);
    const [dispute] = await tx.select().from(partnerCreditAwardDisputes).where(eq(partnerCreditAwardDisputes.id, disputeId)).for('update');
    if (!dispute) throw new DisputeError('DISPUTE_NOT_FOUND');
    return { decision, dispute };
  }

  async open(input: { decisionId: string; actorId: string; evidenceRef: string; note?: string; dedupeKey: string }): Promise<{ disputeId: string; replay: boolean }> {
    if (!text(input.evidenceRef, 500) || !text(input.dedupeKey, 200) || (input.note !== undefined && !text(input.note))) throw new DisputeError('INVALID_INPUT');
    return this.db.transaction(async tx => {
      await requireAdmin(tx, input.actorId);
      const decision = await this.lockDecision(tx, input.decisionId);
      const [replayed] = await tx.select({ disputeId: partnerCreditDisputeEvents.disputeId }).from(partnerCreditDisputeEvents).where(eq(partnerCreditDisputeEvents.dedupeKey, input.dedupeKey));
      if (replayed) return { disputeId: replayed.disputeId, replay: true };
      if (decision.state !== 'provisional' && decision.state !== 'vested') throw new DisputeError('AWARD_NOT_DISPUTABLE'); // reversed/ineligible/cap_exceeded awards have nothing to hold
      const [open] = await tx.select({ id: partnerCreditAwardDisputes.id }).from(partnerCreditAwardDisputes).where(and(eq(partnerCreditAwardDisputes.decisionId, decision.id), eq(partnerCreditAwardDisputes.state, 'open')));
      if (open) throw new DisputeError('DISPUTE_ALREADY_OPEN');
      const [d] = await tx.insert(partnerCreditAwardDisputes).values({ businessId: decision.businessId, decisionId: decision.id }).returning({ id: partnerCreditAwardDisputes.id });
      await tx.insert(partnerCreditDisputeEvents).values({ disputeId: d!.id, businessId: decision.businessId, kind: 'opened', actorId: input.actorId, actorPlatformRole: 'admin', evidenceRef: input.evidenceRef, note: input.note ?? null, dedupeKey: input.dedupeKey });
      return { disputeId: d!.id, replay: false };
    });
  }

  async addEvidence(input: { disputeId: string; actorId: string; evidenceRef: string; note?: string; dedupeKey: string }): Promise<{ replay: boolean }> {
    if (!text(input.evidenceRef, 500) || !text(input.dedupeKey, 200) || (input.note !== undefined && !text(input.note))) throw new DisputeError('INVALID_INPUT');
    return this.db.transaction(async tx => {
      await requireAdmin(tx, input.actorId);
      const { dispute } = await this.lockDispute(tx, input.disputeId);
      const [replayed] = await tx.select({ id: partnerCreditDisputeEvents.id }).from(partnerCreditDisputeEvents).where(eq(partnerCreditDisputeEvents.dedupeKey, input.dedupeKey));
      if (replayed) return { replay: true };
      if (dispute.state !== 'open') throw new DisputeError('DISPUTE_NOT_OPEN');
      await tx.insert(partnerCreditDisputeEvents).values({ disputeId: dispute.id, businessId: dispute.businessId, kind: 'evidence_added', actorId: input.actorId, actorPlatformRole: 'admin', evidenceRef: input.evidenceRef, note: input.note ?? null, dedupeKey: input.dedupeKey });
      return { replay: false };
    });
  }

  async proposeRevocation(input: { disputeId: string; actorId: string }): Promise<{ correctionId: string; replay: boolean }> {
    return this.db.transaction(async tx => {
      await requireAdmin(tx, input.actorId);
      const { dispute } = await this.lockDispute(tx, input.disputeId);
      if (dispute.state !== 'open') throw new DisputeError('DISPUTE_NOT_OPEN');
      const [existing] = await tx.select().from(partnerCreditCorrections).where(and(eq(partnerCreditCorrections.disputeId, dispute.id), eq(partnerCreditCorrections.kind, 'revoke_award')));
      if (existing) {
        if (existing.proposedBy === input.actorId && existing.state === 'proposed') return { correctionId: existing.id, replay: true };
        throw new DisputeError('CORRECTION_ALREADY_EXISTS');
      }
      const [c] = await tx.insert(partnerCreditCorrections).values({ disputeId: dispute.id, businessId: dispute.businessId, kind: 'revoke_award', units: 1, proposedBy: input.actorId }).returning({ id: partnerCreditCorrections.id });
      return { correctionId: c!.id, replay: false };
    });
  }

  /** The decider must be a different active platform administrator than the proposer. */
  async decideCorrection(input: { correctionId: string; actorId: string; approve: boolean; note?: string }): Promise<{ state: 'approved' | 'rejected' }> {
    if (input.note !== undefined && !text(input.note)) throw new DisputeError('INVALID_INPUT');
    return this.db.transaction(async tx => {
      await requireAdmin(tx, input.actorId);
      const [ref] = await tx.select({ disputeId: partnerCreditCorrections.disputeId }).from(partnerCreditCorrections).where(eq(partnerCreditCorrections.id, input.correctionId));
      if (!ref) throw new DisputeError('CORRECTION_NOT_FOUND');
      const { dispute } = await this.lockDispute(tx, ref.disputeId);
      const [c] = await tx.select().from(partnerCreditCorrections).where(eq(partnerCreditCorrections.id, input.correctionId)).for('update');
      if (!c) throw new DisputeError('CORRECTION_NOT_FOUND');
      if (c.state !== 'proposed') throw new DisputeError('CORRECTION_NOT_PROPOSED');
      if (dispute.state !== 'open') throw new DisputeError('DISPUTE_NOT_OPEN');
      if (c.proposedBy === input.actorId) throw new DisputeError('SELF_APPROVAL');
      const state = input.approve ? 'approved' as const : 'rejected' as const;
      await tx.update(partnerCreditCorrections).set({ state, decidedBy: input.actorId, decidedAt: new Date(), decisionNote: input.note ?? null }).where(eq(partnerCreditCorrections.id, c.id));
      return { state };
    });
  }

  /**
   * `upheld`: the award stands and the hold is lifted (refused while a correction is still undecided). `revoked`: requires an APPROVED correction from a
   * different administrator; the hold STAYS and an approved, unexecuted plan is recorded for a later authorized executor.
   */
  async resolve(input: { disputeId: string; actorId: string; outcome: 'upheld' | 'revoked'; evidenceRef: string; dedupeKey: string; note?: string }): Promise<{ state: 'released' | 'revoked'; replay: boolean }> {
    if (!text(input.evidenceRef, 500) || !text(input.dedupeKey, 200) || (input.note !== undefined && !text(input.note)) || (input.outcome !== 'upheld' && input.outcome !== 'revoked')) throw new DisputeError('INVALID_INPUT');
    return this.db.transaction(async tx => {
      await requireAdmin(tx, input.actorId);
      const { dispute } = await this.lockDispute(tx, input.disputeId);
      const [replayed] = await tx.select({ id: partnerCreditDisputeEvents.id }).from(partnerCreditDisputeEvents).where(eq(partnerCreditDisputeEvents.dedupeKey, input.dedupeKey));
      if (replayed) return { state: dispute.state === 'revoked' ? 'revoked' as const : 'released' as const, replay: true };
      if (dispute.state !== 'open') throw new DisputeError('DISPUTE_NOT_OPEN');
      const [c] = await tx.select().from(partnerCreditCorrections).where(and(eq(partnerCreditCorrections.disputeId, dispute.id), eq(partnerCreditCorrections.kind, 'revoke_award')));
      if (input.outcome === 'upheld') {
        if (c?.state === 'proposed') throw new DisputeError('CORRECTION_PENDING');
        await tx.update(partnerCreditAwardDisputes).set({ state: 'released', resolvedAt: new Date(), revision: sql`${partnerCreditAwardDisputes.revision} + 1` as never }).where(eq(partnerCreditAwardDisputes.id, dispute.id));
        await tx.insert(partnerCreditDisputeEvents).values({ disputeId: dispute.id, businessId: dispute.businessId, kind: 'resolved_upheld', actorId: input.actorId, actorPlatformRole: 'admin', evidenceRef: input.evidenceRef, note: input.note ?? null, dedupeKey: input.dedupeKey });
        return { state: 'released' as const, replay: false };
      }
      if (!c || c.state !== 'approved' || !c.decidedBy || c.decidedBy === c.proposedBy) throw new DisputeError('DUAL_APPROVAL_REQUIRED');
      const plan = { type: 'revoke_award', decisionId: dispute.decisionId, units: c.units, correctionId: c.id, proposedBy: c.proposedBy, approvedBy: c.decidedBy, executed: false };
      await tx.update(partnerCreditAwardDisputes).set({ state: 'revoked', resolvedAt: new Date(), plan, revision: sql`${partnerCreditAwardDisputes.revision} + 1` as never }).where(eq(partnerCreditAwardDisputes.id, dispute.id));
      await tx.insert(partnerCreditDisputeEvents).values({ disputeId: dispute.id, businessId: dispute.businessId, kind: 'resolved_revoked', actorId: input.actorId, actorPlatformRole: 'admin', evidenceRef: input.evidenceRef, note: input.note ?? null, dedupeKey: input.dedupeKey });
      return { state: 'revoked' as const, replay: false };
    });
  }
}
