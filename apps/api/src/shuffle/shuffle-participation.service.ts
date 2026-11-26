import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  auditLog, qualificationRuleVersions, shuffleAllocationEvents, shuffleCampaignVersions, shuffleCampaigns, shuffleEligibilitySnapshots, shuffleEntries,
  shuffleDropAllocations, shuffleInvitationEvents, shuffleInvitations, shuffleNotificationIntents, shuffleSelectionResults, type ShuffleInvitationStatus,
} from '../db/schema';
import { AppError } from '../lib/errors';
import { evaluateRuleForCustomer } from '../qualification/qualification-evaluator';
import { chainAudit, selectEntrants, verifyChain, verifySelection, type AuditLink } from './shuffle-selection';

export type Actor = { actorUserId: string; ipAddress?: string | null; userAgent?: string | null };
const conflict = (m: string, code: string) => new AppError(m, 409, code);
const notFound = (m: string, code: string) => new AppError(m, 404, code);

/**
 * TSH-05 invitations/entries and the TSH-04 integration, SYNTHETIC ONLY: the database fixes `synthetic = true`, versions cannot be released and no
 * customer-facing route exists. Distinct from business invitations and referrals: an invitation binds ONE qualified snapshot of ONE campaign version;
 * it is not eligibility, consent, entry or an allocation by itself, and eligibility is re-evaluated server-side at acceptance. Notification intents are
 * informational and held (never delivered). The selection result and every state change are recorded on a per-version hash chain.
 */
export class ShuffleParticipationService {
  constructor(private readonly db: Db) {}

  private async version(tx: Db, versionId: string) {
    const [v] = await tx.select().from(shuffleCampaignVersions).where(eq(shuffleCampaignVersions.id, versionId)).limit(1);
    if (!v) throw notFound('Campaign version not found.', 'CAMPAIGN_NOT_FOUND');
    const [c] = await tx.select().from(shuffleCampaigns).where(eq(shuffleCampaigns.id, v.campaignId)).limit(1);
    return { v, c: c! };
  }

  private async lock(tx: Db, key: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`); }

  /** Appends one event to the version's hash chain (serialised per version). Used by the selection->allocation orchestration so the link is tamper-evident (TSH-01 section 8). */
  recordChainEvent(tx: Db, versionId: string, event: Record<string, unknown>, ctx: Actor) { return this.append(tx, versionId, event, ctx); }

  private async append(tx: Db, versionId: string, event: Record<string, unknown>, ctx: Actor) {
    await this.lock(tx, `shuffle_chain:${versionId}`);
    const [last] = await tx.select({ seq: shuffleAllocationEvents.seq, hash: shuffleAllocationEvents.hash }).from(shuffleAllocationEvents).where(eq(shuffleAllocationEvents.campaignVersionId, versionId)).orderBy(sql`seq desc`).limit(1);
    const link = chainAudit(last?.hash ?? null, event);
    await tx.insert(shuffleAllocationEvents).values({ campaignVersionId: versionId, seq: (last?.seq ?? 0) + 1, prevHash: link.prev, hash: link.hash, event, actorUserId: ctx.actorUserId });
  }

  private async audit(tx: Db, action: string, entityId: string, ctx: Actor, metadata: Record<string, unknown>) {
    await tx.insert(auditLog).values({ businessId: null, actorUserId: ctx.actorUserId, action, entityType: 'shuffle_campaign', entityId, metadata: { outcome: 'success', synthetic: true, ...metadata }, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null });
  }

  private async move(tx: Db, inv: { id: string; status: ShuffleInvitationStatus; campaignVersionId: string }, to: ShuffleInvitationStatus, reason: string | null, ctx: Actor) {
    await tx.update(shuffleInvitations).set({ status: to, statusChangedAt: new Date() }).where(eq(shuffleInvitations.id, inv.id));
    await tx.insert(shuffleInvitationEvents).values({ invitationId: inv.id, fromStatus: inv.status, toStatus: to, actorUserId: ctx.actorUserId, reason });
    await this.append(tx, inv.campaignVersionId, { type: `invitation_${to}`, invitationId: inv.id, from: inv.status, reason }, ctx);
  }

  /** Issue ONE invitation for a QUALIFIED snapshot. Idempotent. The expiry is supplied by the administrator (never defaulted) and bounded by the acceptance deadline. */
  async issueInvitation(versionId: string, customerId: string, expiresAt: Date, ctx: Actor) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const { v, c } = await this.version(db, versionId);
      if (c.status !== 'draft') throw conflict('Invitations can only be issued for an active campaign.', 'CAMPAIGN_NOT_DRAFT');
      const [existing] = await tx.select().from(shuffleInvitations).where(and(eq(shuffleInvitations.campaignVersionId, versionId), eq(shuffleInvitations.customerId, customerId))).limit(1);
      if (existing) return { invitation: existing, created: false };
      const [snap] = await tx.select().from(shuffleEligibilitySnapshots).where(and(eq(shuffleEligibilitySnapshots.campaignVersionId, versionId), eq(shuffleEligibilitySnapshots.customerId, customerId))).limit(1);
      if (!snap?.qualified) throw conflict('Only a customer with a recorded qualified eligibility snapshot can be invited.', 'INVITATION_NOT_QUALIFIED');
      if (!(expiresAt.getTime() > Date.now()) || expiresAt > v.entryAcceptanceDeadline) throw new AppError('The invitation must expire in the future and no later than the entry acceptance deadline.', 422, 'INVITATION_EXPIRY_INVALID');
      const [invitation] = await tx.insert(shuffleInvitations).values({ campaignId: v.campaignId, campaignVersionId: versionId, customerId, snapshotId: snap.id, expiresAt, createdByUserId: ctx.actorUserId }).returning();
      await tx.insert(shuffleInvitationEvents).values({ invitationId: invitation!.id, fromStatus: null, toStatus: 'generated', actorUserId: ctx.actorUserId });
      await tx.insert(shuffleNotificationIntents).values({ invitationId: invitation!.id });
      await this.append(db, versionId, { type: 'invitation_generated', invitationId: invitation!.id, snapshotId: snap.id }, ctx);
      await this.audit(db, 'shuffle_invitation.generated', v.campaignId, ctx, { versionId, invitationId: invitation!.id });
      return { invitation: invitation!, created: true };
    });
  }

  private async load(tx: Db, invitationId: string) {
    const [inv] = await tx.select().from(shuffleInvitations).where(eq(shuffleInvitations.id, invitationId)).for('update').limit(1);
    if (!inv) throw notFound('Invitation not found.', 'INVITATION_NOT_FOUND');
    return inv;
  }

  async markViewed(invitationId: string, ctx: Actor) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; const inv = await this.load(db, invitationId);
      if (inv.status === 'generated') await this.move(db, inv, 'viewed', null, ctx);
      return { status: inv.status === 'generated' ? 'viewed' : inv.status };
    });
  }

  async decline(invitationId: string, ctx: Actor) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; const inv = await this.load(db, invitationId);
      if (inv.status === 'declined') return { status: 'declined' as const };
      if (inv.status !== 'generated' && inv.status !== 'viewed') throw conflict('This invitation can no longer be declined.', 'INVITATION_TRANSITION_NOT_ALLOWED');
      await this.move(db, inv, 'declined', null, ctx);
      return { status: 'declined' as const };
    });
  }

  /** Withdraw (e.g. qualification invalidated, D-5: before allocation). Requires a reason. */
  async withdraw(invitationId: string, reason: string, ctx: Actor) {
    if (!reason.trim()) throw new AppError('A reason is required.', 422, 'REASON_REQUIRED');
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; const inv = await this.load(db, invitationId);
      if (inv.status === 'withdrawn') return { status: 'withdrawn' as const };
      if (!['generated', 'viewed', 'accepted'].includes(inv.status)) throw conflict('This invitation can no longer be withdrawn.', 'INVITATION_TRANSITION_NOT_ALLOWED');
      await this.move(db, inv, 'withdrawn', reason.trim(), ctx);
      if (inv.status === 'accepted') await tx.update(shuffleEntries).set({ status: 'cancelled', statusReason: reason.trim(), statusChangedAt: new Date() }).where(and(eq(shuffleEntries.invitationId, inv.id), sql`${shuffleEntries.status} IN ('accepted','admitted')`));
      return { status: 'withdrawn' as const };
    });
  }

  /** Marks every invitation of a version whose expiry has passed as expired (the database refuses early expiry). */
  async expireDue(versionId: string, ctx: Actor) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; let n = 0;
      const due = await tx.select().from(shuffleInvitations).where(and(eq(shuffleInvitations.campaignVersionId, versionId), sql`${shuffleInvitations.status} IN ('generated','viewed') AND ${shuffleInvitations.expiresAt} <= now()`)).for('update');
      for (const inv of due) { await this.move(db, inv, 'expired', 'expiry passed', ctx); n++; }
      return { expired: n };
    });
  }

  /**
   * Acceptance by the invited customer (synthetic harness acts for a synthetic customer). Binds the EXACT terms version and disclosure hash that were
   * shown (D-4); eligibility is re-evaluated server-side from evidence at this moment (never trusted from the invitation or snapshot); capacity is
   * checked under a version lock. Idempotent for an already accepted invitation.
   */
  async accept(invitationId: string, shown: { termsVersion: string; disclosureHash: string }, ctx: Actor) {
    const out = await this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; const inv = await this.load(db, invitationId);
      const { v, c } = await this.version(db, inv.campaignVersionId);
      const [prior] = await tx.select().from(shuffleEntries).where(eq(shuffleEntries.invitationId, inv.id)).limit(1);
      if (prior) return { entry: prior, created: false, rejected: false as const };
      if (c.status !== 'draft') throw conflict('The campaign is not active.', 'CAMPAIGN_NOT_DRAFT');
      if (inv.status !== 'generated' && inv.status !== 'viewed') throw conflict('This invitation can no longer be accepted.', 'INVITATION_TRANSITION_NOT_ALLOWED');
      if (inv.expiresAt <= new Date() || v.entryAcceptanceDeadline <= new Date()) throw conflict('This invitation has expired.', 'INVITATION_EXPIRED');
      if (shown.termsVersion !== v.termsVersion || shown.disclosureHash !== v.disclosureHash) throw conflict('The terms or disclosure shown are not those of this campaign version.', 'DISCLOSURE_MISMATCH');
      const [rule] = await tx.select().from(qualificationRuleVersions).where(and(eq(qualificationRuleVersions.id, v.qualificationRuleVersionId), eq(qualificationRuleVersions.approvalState, 'approved'))).limit(1);
      const result = rule ? await evaluateRuleForCustomer(db, inv.customerId, rule, { consumerKind: 'campaign', between: { start: v.qualificationWindowStart, end: v.qualificationWindowEnd } }) : null;
      if (!result?.outcome.qualified) {
        await this.move(db, inv, 'withdrawn', 'eligibility no longer met at acceptance', ctx);
        await this.audit(db, 'shuffle_invitation.withdrawn', v.campaignId, ctx, { versionId: v.id, invitationId: inv.id, reason: 'not_eligible' });
        return { rejected: true as const }; // committed: the withdrawal must persist, so the error is raised after the transaction
      }
      await this.lock(db, `shuffle_admit:${v.id}`);
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(shuffleEntries).where(and(eq(shuffleEntries.campaignVersionId, v.id), eq(shuffleEntries.status, 'admitted')));
      if (n >= v.maxCapacity) throw conflict('The campaign has reached its maximum capacity.', 'CAPACITY_REACHED');
      await tx.update(shuffleInvitations).set({ status: 'accepted', statusChangedAt: new Date() }).where(eq(shuffleInvitations.id, inv.id));
      await tx.insert(shuffleInvitationEvents).values({ invitationId: inv.id, fromStatus: inv.status, toStatus: 'accepted', actorUserId: ctx.actorUserId });
      const [entry] = await tx.insert(shuffleEntries).values({ invitationId: inv.id, campaignVersionId: v.id, customerId: inv.customerId, acceptedTermsVersion: v.termsVersion, acceptedDisclosureHash: v.disclosureHash }).returning();
      const [admitted] = await tx.update(shuffleEntries).set({ status: 'admitted', statusChangedAt: new Date() }).where(eq(shuffleEntries.id, entry!.id)).returning();
      await this.append(db, v.id, { type: 'entry_admitted', entryId: entry!.id, invitationId: inv.id, evidenceIds: result.evidenceIds, termsVersion: v.termsVersion, disclosureHash: v.disclosureHash }, ctx);
      await this.audit(db, 'shuffle_entry.admitted', v.campaignId, ctx, { versionId: v.id, entryId: entry!.id });
      return { entry: admitted!, created: true, rejected: false as const };
    });
    if (out.rejected) throw conflict('Eligibility is no longer met, so the invitation was withdrawn.', 'ELIGIBILITY_NOT_MET');
    return out;
  }

  async cancelEntry(entryId: string, reason: string, ctx: Actor) {
    if (!reason.trim()) throw new AppError('A reason is required.', 422, 'REASON_REQUIRED');
    return this.db.transaction(async (tx) => this.cancelEntryWithin(tx as unknown as Db, entryId, reason, ctx));
  }

  /** The cancellation itself, usable inside a caller's transaction (TSH-08 two-person override). Locked after a selection is recorded (D-5). */
  async cancelEntryWithin(tx: Db, entryId: string, reason: string, ctx: Actor) {
    if (!reason.trim()) throw new AppError('A reason is required.', 422, 'REASON_REQUIRED');
    const [e] = await tx.select().from(shuffleEntries).where(eq(shuffleEntries.id, entryId)).for('update').limit(1);
    if (!e) throw notFound('Entry not found.', 'ENTRY_NOT_FOUND');
    if (e.status === 'cancelled') return { status: 'cancelled' as const };
    const [sel] = await tx.select({ id: shuffleSelectionResults.id }).from(shuffleSelectionResults).where(eq(shuffleSelectionResults.campaignVersionId, e.campaignVersionId)).limit(1);
    if (sel) throw conflict('After a selection is recorded an entry can only change through an approved dispute process (D-5); no silent revocation.', 'ENTRY_LOCKED_AFTER_SELECTION');
    await tx.update(shuffleEntries).set({ status: 'cancelled', statusReason: reason.trim(), statusChangedAt: new Date() }).where(eq(shuffleEntries.id, entryId));
    await this.append(tx, e.campaignVersionId, { type: 'entry_cancelled', entryId, reason: reason.trim() }, ctx);
    return { status: 'cancelled' as const };
  }

  /**
   * SYNTHETIC selection over the admitted entries using the isolated CSPRNG primitive. The winner count is supplied by the administrator (never defaulted).
   * Mode A (guaranteed): every admitted entry must be selected (D-3). Mode B (limited): 1..n. Requires the minimum participants (database).
   * Recorded once per version; the random draws are stored so the result is replay-verifiable.
   */
  async runSyntheticSelection(versionId: string, winnerCount: number, ctx: Actor) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const { v, c } = await this.version(db, versionId);
      if (c.status !== 'draft') throw conflict('The campaign is not active.', 'CAMPAIGN_NOT_DRAFT');
      await this.lock(db, `shuffle_admit:${versionId}`);
      const [done] = await tx.select().from(shuffleSelectionResults).where(eq(shuffleSelectionResults.campaignVersionId, versionId)).limit(1);
      if (done) return { result: done, created: false };
      const admitted = await tx.select({ id: shuffleEntries.id }).from(shuffleEntries).where(and(eq(shuffleEntries.campaignVersionId, versionId), eq(shuffleEntries.status, 'admitted'))).orderBy(asc(shuffleEntries.id));
      if (admitted.length < v.minParticipants) throw conflict('The minimum number of participants has not been reached.', 'MIN_PARTICIPANTS_NOT_REACHED');
      if (!Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > admitted.length) throw new AppError('The winner count must be between 1 and the number of admitted entries.', 422, 'WINNER_COUNT_INVALID');
      if (v.mode === 'guaranteed' && winnerCount !== admitted.length) throw new AppError('In a guaranteed campaign every admitted entry receives an outcome, so the winner count must equal the admitted entries.', 422, 'GUARANTEED_MODE_REQUIRES_ALL');
      const entrantIds = admitted.map((a) => a.id);
      const sel = selectEntrants({ entrantIds, winnerCount });
      const [row] = await tx.insert(shuffleSelectionResults).values({ campaignVersionId: versionId, entrantCount: entrantIds.length, winnerCount, selectedEntryIds: [...sel.selectedIds], inputCommitment: sel.inputCommitment, resultCommitment: sel.resultCommitment, transcript: [...sel.transcript], createdByUserId: ctx.actorUserId }).returning();
      await this.append(db, versionId, { type: 'selection_recorded', entrantIds: [...entrantIds].sort(), winnerCount, inputCommitment: sel.inputCommitment, resultCommitment: sel.resultCommitment }, ctx);
      await this.audit(db, 'shuffle_selection.recorded', v.campaignId, ctx, { versionId, winnerCount, entrantCount: entrantIds.length });
      return { result: row!, created: true };
    });
  }

  /** Deterministic verification of recorded evidence: the chain recomputes, and the selection replays from the recorded draws and recorded entrants. */
  async verifyEvidence(versionId: string) {
    const links = await this.db.select().from(shuffleAllocationEvents).where(eq(shuffleAllocationEvents.campaignVersionId, versionId)).orderBy(asc(shuffleAllocationEvents.seq));
    const chain: AuditLink[] = links.map((l) => ({ prev: l.prevHash, hash: l.hash, event: l.event }));
    const contiguous = links.every((l, i) => l.seq === i + 1);
    const chainOk = contiguous && verifyChain(chain);
    const [sel] = await this.db.select().from(shuffleSelectionResults).where(eq(shuffleSelectionResults.campaignVersionId, versionId)).limit(1);
    let selectionOk: boolean | null = null;
    if (sel) {
      const ev = links.find((l) => l.event.type === 'selection_recorded')?.event as { entrantIds?: string[]; winnerCount?: number; inputCommitment?: string; resultCommitment?: string } | undefined;
      selectionOk = !!ev && ev.inputCommitment === sel.inputCommitment && ev.resultCommitment === sel.resultCommitment && Array.isArray(ev.entrantIds)
        && verifySelection({ entrantIds: ev.entrantIds, winnerCount: sel.winnerCount }, { selectedIds: sel.selectedEntryIds, entrantCount: sel.entrantCount, inputCommitment: sel.inputCommitment, resultCommitment: sel.resultCommitment, transcript: sel.transcript });
    }
    // G12: every recorded selection->allocation link must have exactly one chain event and vice versa (a deleted or invented link row is detected)
    const linkEvents = links.filter((l) => l.event.type === 'drop_allocation_linked').map((l) => String(l.event.reservationId)).sort();
    const linkRows = (await this.db.select({ r: shuffleDropAllocations.reservationId }).from(shuffleDropAllocations).where(eq(shuffleDropAllocations.campaignVersionId, versionId))).map((x) => x.r).sort();
    const linksOk: boolean | null = linkEvents.length === 0 && linkRows.length === 0 ? null : JSON.stringify(linkEvents) === JSON.stringify(linkRows);
    return { events: links.length, chainOk, selectionRecorded: !!sel, selectionOk, linksOk };
  }

  async counts(versionId: string) {
    const r = await this.db.execute<{ k: string; s: string; n: number }>(sql`
      select 'invitation' as k, status as s, count(*)::int as n from shuffle_invitations where campaign_version_id = ${versionId} group by status
      union all select 'entry', status, count(*)::int from shuffle_entries where campaign_version_id = ${versionId} group by status`);
    const out: Record<string, Record<string, number>> = { invitations: {}, entries: {} };
    for (const x of r.rows ?? []) (out[x.k === 'invitation' ? 'invitations' : 'entries'] as Record<string, number>)[x.s] = Number(x.n);
    return out;
  }
}
