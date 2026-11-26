import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  auditLog, businesses, dropEvents, dropInventory, dropReservations, dropSponsorshipVersions, dropSponsorships, qualificationRuleVersions, type DropSponsorshipStatus,
} from '../db/schema';
import { AppError } from '../lib/errors';
import { canonicalJson, chainAudit, verifyChain, type AuditLink } from '../lib/audit-chain';
import { evaluateRuleForCustomer } from '../qualification/qualification-evaluator';

export type Actor = { actorUserId: string; ipAddress?: string | null; userAgent?: string | null };
export type DropContent = {
  productName: string; description: string; quantityTotal: number; collectionMethod: string; collectionLocation: string;
  collectionWindowStart: Date; collectionWindowEnd: Date; offerExpiresAt: Date; qualificationRuleVersionId: string;
};
const conflict = (m: string, code: string) => new AppError(m, 409, code);
const bad = (m: string, code = 'VALIDATION_ERROR') => new AppError(m, 422, code);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Surfaces the database guard's message (drizzle wraps the pg error) so the application maps it to a typed outcome instead of a 500. */
const dbMessage = (e: unknown): string => { const x = e as { message?: string; cause?: { message?: string } }; return `${x?.message ?? ''} ${x?.cause?.message ?? ''}`; };

/**
 * TDP-02 sponsorship and atomic inventory, SYNTHETIC ONLY and PAYMENT-FREE (no price, payment, tax or obligation field exists; synthetic = true is a CHECK).
 * Two separate state machines: the sponsorship offer (this service) and the reservation/allocation unit. Inventory integrity is enforced by the database
 * (single authoritative row, trigger-maintained counters, CHECK sum <= total), so no application bug can oversubscribe. Eligibility is the shared
 * qualification engine against the APPROVED rule version of the approved sponsorship version, evaluated on the server at reservation AND at allocation.
 * A sponsor never chooses who is reserved, and an allocated unit is never silently withdrawn.
 */
export class DropSponsorshipService {
  constructor(private readonly db: Db) {}

  private check(c: DropContent) {
    if (!Number.isInteger(c.quantityTotal) || c.quantityTotal < 1) throw bad('The quantity must be a whole number of at least 1.', 'DROP_QUANTITY_INVALID');
    if (!(c.collectionWindowEnd > c.collectionWindowStart) || !(c.offerExpiresAt > new Date())) throw bad('The collection window or the offer expiry is invalid.', 'DROP_DATES_INVALID');
    for (const [k, v, max] of [['product name', c.productName, 120], ['description', c.description, 1000], ['collection method', c.collectionMethod, 300], ['collection location', c.collectionLocation, 300]] as const) {
      if (!v.trim() || v.length > max) throw bad(`The ${k} must be 1 to ${max} characters.`);
    }
  }

  private async values(tx: Db, c: DropContent) {
    this.check(c);
    const [rule] = await tx.select({ id: qualificationRuleVersions.id, participantType: qualificationRuleVersions.participantType }).from(qualificationRuleVersions).where(eq(qualificationRuleVersions.id, c.qualificationRuleVersionId)).limit(1);
    if (!rule || rule.participantType !== 'customer') throw bad('Eligibility must reference an existing customer qualification rule version.', 'DROP_RULE_INVALID');
    return { ...c, productName: c.productName.trim(), description: c.description.trim(), contentHash: sha(canonicalJson({ ...c, collectionWindowStart: c.collectionWindowStart.toISOString(), collectionWindowEnd: c.collectionWindowEnd.toISOString(), offerExpiresAt: c.offerExpiresAt.toISOString() })) };
  }

  private async append(tx: Db, sponsorshipId: string, event: Record<string, unknown>, ctx: Actor) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'drop_chain:' + sponsorshipId}, 0))`);
    const [last] = await tx.select({ seq: dropEvents.seq, hash: dropEvents.hash }).from(dropEvents).where(eq(dropEvents.sponsorshipId, sponsorshipId)).orderBy(sql`seq desc`).limit(1);
    const link = chainAudit(last?.hash ?? null, event);
    await tx.insert(dropEvents).values({ sponsorshipId, seq: (last?.seq ?? 0) + 1, prevHash: link.prev, hash: link.hash, event, actorUserId: ctx.actorUserId });
    await tx.insert(auditLog).values({ businessId: null, actorUserId: ctx.actorUserId, action: `drop.${String(event.type)}`, entityType: 'drop_sponsorship', entityId: sponsorshipId, metadata: { outcome: 'success', synthetic: true, ...event }, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null });
  }

  private async sponsorship(tx: Db, id: string, lock = false) {
    const q = tx.select().from(dropSponsorships).where(eq(dropSponsorships.id, id)).limit(1);
    const [s] = lock ? await q.for('update') : await q;
    if (!s) throw new AppError('Sponsorship not found.', 404, 'SPONSORSHIP_NOT_FOUND');
    return s;
  }

  async create(input: { key: string; businessId: string } & DropContent, ctx: Actor) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const [biz] = await tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1);
      if (!biz) throw new AppError('Business not found.', 404, 'BUSINESS_NOT_FOUND');
      const v = await this.values(db, input);
      const [s] = await tx.insert(dropSponsorships).values({ key: input.key, businessId: input.businessId, createdByUserId: ctx.actorUserId }).onConflictDoNothing().returning();
      if (!s) throw conflict('A sponsorship with that key already exists.', 'SPONSORSHIP_KEY_TAKEN');
      const [ver] = await tx.insert(dropSponsorshipVersions).values({ sponsorshipId: s.id, version: 1, ...v, createdByUserId: ctx.actorUserId }).returning();
      await this.append(db, s.id, { type: 'created', versionId: ver!.id, businessId: input.businessId }, ctx);
      return { sponsorship: s, version: ver! };
    });
  }

  async addVersion(id: string, c: DropContent, ctx: Actor) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; const s = await this.sponsorship(db, id, true);
      if (s.status !== 'draft') throw conflict('Versions can only be added while the sponsorship is a draft.', 'SPONSORSHIP_NOT_DRAFT');
      const v = await this.values(db, c);
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`coalesce(max(${dropSponsorshipVersions.version}), 0)::int` }).from(dropSponsorshipVersions).where(eq(dropSponsorshipVersions.sponsorshipId, id));
      const [row] = await tx.insert(dropSponsorshipVersions).values({ sponsorshipId: id, version: n + 1, ...v, createdByUserId: ctx.actorUserId }).returning();
      await this.append(db, id, { type: 'version_added', versionId: row!.id, version: row!.version }, ctx);
      return row!;
    });
  }

  /** Generic status move; the database enforces the legal machine, reasons and separation of duties. Idempotent when already in the target status. */
  async move(id: string, target: DropSponsorshipStatus, ctx: Actor, opts: { reason?: string } = {}) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; const s = await this.sponsorship(db, id, true);
      if (s.status === target) return { sponsorship: s, changed: false };
      const reason = opts.reason?.trim() || null;
      if (['draft', 'suspended', 'cancelled'].includes(target) && !reason) throw bad('A reason is required.', 'REASON_REQUIRED');
      const set: Record<string, unknown> = { status: target, statusReason: reason };
      if (target === 'approved') {
        if (s.createdByUserId === ctx.actorUserId) throw new AppError('A sponsorship cannot be approved by the person who created it.', 403, 'SEPARATION_OF_DUTIES');
        const [latest] = await tx.select().from(dropSponsorshipVersions).where(eq(dropSponsorshipVersions.sponsorshipId, id)).orderBy(sql`version desc`).limit(1);
        set.approvedVersionId = latest!.id; set.reviewedByUserId = ctx.actorUserId; set.reviewedAt = new Date();
      }
      if (target === 'draft') { set.approvedVersionId = null; set.reviewedByUserId = null; set.reviewedAt = null; }
      if (target !== 'draft' && target !== 'suspended' && target !== 'cancelled') set.statusReason = null;
      try {
        if (target === 'approved') {
          const [updated] = await tx.update(dropSponsorships).set(set).where(eq(dropSponsorships.id, id)).returning();
          const [ver] = await tx.select().from(dropSponsorshipVersions).where(eq(dropSponsorshipVersions.id, updated!.approvedVersionId!)).limit(1);
          await tx.insert(dropInventory).values({ sponsorshipId: id, totalQuantity: ver!.quantityTotal });
          await this.append(db, id, { type: 'approved', versionId: ver!.id, quantity: ver!.quantityTotal }, ctx);
          return { sponsorship: updated!, changed: true };
        }
        const [updated] = await tx.update(dropSponsorships).set(set).where(eq(dropSponsorships.id, id)).returning();
        await this.append(db, id, { type: `status_${target}`, from: s.status, reason }, ctx);
        return { sponsorship: updated!, changed: true };
      } catch (e) {
        const m = dbMessage(e);
        if (m.includes('TRANSITION_NOT_ALLOWED')) throw conflict(`A sponsorship cannot move from ${s.status} to ${target}.`, 'SPONSORSHIP_TRANSITION_NOT_ALLOWED');
        if (m.includes('REVIEW_REQUIRED')) throw new AppError('An independent reviewer approving the latest version is required.', 403, 'SEPARATION_OF_DUTIES');
        if (m.includes('NOT_READY')) throw conflict('The sponsorship needs an approved version and inventory.', 'SPONSORSHIP_NOT_READY');
        throw e;
      }
    });
  }

  private async approvedRule(tx: Db, sponsorshipId: string) {
    const [row] = await tx.select({ rule: qualificationRuleVersions, ver: dropSponsorshipVersions }).from(dropSponsorships)
      .innerJoin(dropSponsorshipVersions, eq(dropSponsorshipVersions.id, dropSponsorships.approvedVersionId))
      .innerJoin(qualificationRuleVersions, and(eq(qualificationRuleVersions.id, dropSponsorshipVersions.qualificationRuleVersionId), eq(qualificationRuleVersions.approvalState, 'approved')))
      .where(eq(dropSponsorships.id, sponsorshipId)).limit(1);
    return row ?? null;
  }

  private async evaluate(tx: Db, sponsorshipId: string, customerId: string) {
    const row = await this.approvedRule(tx, sponsorshipId);
    if (!row) throw conflict('No approved qualification rule backs this sponsorship, so eligibility cannot be established.', 'QUALIFICATION_NOT_APPROVED');
    const r = await evaluateRuleForCustomer(tx, customerId, row.rule, { consumerKind: 'campaign' });
    if (!r?.outcome.qualified) throw conflict('The customer is not eligible for this sponsorship.', 'ELIGIBILITY_NOT_MET');
    return { evidence: { ruleVersionId: row.rule.id, specHash: row.rule.specHash, pathways: r.outcome.pathways, evidenceIds: r.evidenceIds, evidenceLevel: 'recorded' }, ver: row.ver };
  }

  /** Atomic reservation: one transaction, eligibility on the server, the unit taken by a guarded counter in the database. Idempotent per customer. */
  async reserve(sponsorshipId: string, customerId: string, holdExpiresAt: Date, ctx: Actor) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const [prior] = await tx.select().from(dropReservations).where(and(eq(dropReservations.sponsorshipId, sponsorshipId), eq(dropReservations.customerId, customerId))).limit(1);
      if (prior) return { reservation: prior, created: false };
      const s = await this.sponsorship(db, sponsorshipId);
      if (s.status !== 'available') throw conflict('The sponsorship is not available.', 'SPONSORSHIP_NOT_AVAILABLE');
      const { evidence, ver } = await this.evaluate(db, sponsorshipId, customerId);
      if (ver.offerExpiresAt <= new Date()) throw conflict('The offer has expired.', 'OFFER_EXPIRED');
      if (!(holdExpiresAt > new Date()) || holdExpiresAt > ver.offerExpiresAt) throw bad('The hold must expire in the future and not after the offer expires.', 'HOLD_EXPIRY_INVALID');
      try {
        const [row] = await tx.insert(dropReservations).values({ sponsorshipId, customerId, holdExpiresAt, eligibilityEvidence: evidence, createdByUserId: ctx.actorUserId }).returning();
        await this.append(db, sponsorshipId, { type: 'reserved', reservationId: row!.id }, ctx);
        return { reservation: row!, created: true };
      } catch (e) {
        if (dbMessage(e).includes('INVENTORY_EXHAUSTED')) throw conflict('No inventory remains.', 'INVENTORY_EXHAUSTED');
        throw e;
      }
    });
  }

  private async load(tx: Db, reservationId: string) {
    const [r] = await tx.select().from(dropReservations).where(eq(dropReservations.id, reservationId)).for('update').limit(1);
    if (!r) throw new AppError('Reservation not found.', 404, 'RESERVATION_NOT_FOUND');
    return r;
  }

  /** reserved -> allocated, after re-validating eligibility immediately before allocation (TSH-01 section 6). A failed re-check releases the unit. */
  async allocate(reservationId: string, ctx: Actor) {
    const out = await this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; const r = await this.load(db, reservationId);
      if (r.status === 'allocated') return { reservation: r, ok: true as const };
      if (r.status !== 'reserved') throw conflict('Only a reserved unit can be allocated.', 'RESERVATION_TRANSITION_NOT_ALLOWED');
      try { await this.evaluate(db, r.sponsorshipId, r.customerId); } catch (e) {
        if (e instanceof AppError && e.code === 'ELIGIBILITY_NOT_MET') {
          await tx.update(dropReservations).set({ status: 'released', statusReason: 'eligibility no longer met at allocation' }).where(eq(dropReservations.id, r.id));
          await this.append(db, r.sponsorshipId, { type: 'released', reservationId: r.id, reason: 'eligibility no longer met at allocation' }, ctx);
          return { ok: false as const };
        }
        throw e;
      }
      try {
        const [row] = await tx.update(dropReservations).set({ status: 'allocated' }).where(eq(dropReservations.id, r.id)).returning();
        await this.append(db, r.sponsorshipId, { type: 'allocated', reservationId: r.id }, ctx);
        return { reservation: row!, ok: true as const };
      } catch (e) {
        if (dbMessage(e).includes('NOT_ALLOWED')) throw conflict('The sponsorship is not available or the hold expired.', 'RESERVATION_NOT_ALLOWED');
        throw e;
      }
    });
    if (!out.ok) throw conflict('Eligibility is no longer met, so the reservation was released.', 'ELIGIBILITY_NOT_MET');
    return out.reservation;
  }

  async release(reservationId: string, reason: string, ctx: Actor) {
    if (!reason.trim()) throw bad('A reason is required.', 'REASON_REQUIRED');
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; const r = await this.load(db, reservationId);
      if (r.status === 'released') return { status: 'released' as const };
      if (r.status !== 'reserved') throw conflict('An allocated unit is never silently withdrawn; only a reserved hold can be released.', 'RESERVATION_TRANSITION_NOT_ALLOWED');
      await tx.update(dropReservations).set({ status: 'released', statusReason: reason.trim() }).where(eq(dropReservations.id, r.id));
      await this.append(db, r.sponsorshipId, { type: 'released', reservationId: r.id, reason: reason.trim() }, ctx);
      return { status: 'released' as const };
    });
  }

  /**
   * TDP-03 collection verification (synthetic): allocated -> collected, only inside the published collection window and only by the verifying actor, whose
   * identity is recorded on the evidence chain. No automatic debt or liability follows (D-5): this records a verified collection and nothing else.
   * Idempotent. A real fulfilment permission for counter staff needs the Owner's decision (cashiers get only fulfilment verification, never more).
   */
  async collect(reservationId: string, ctx: Actor) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; const r = await this.load(db, reservationId);
      if (r.status === 'collected') return { status: 'collected' as const, created: false };
      if (r.status !== 'allocated') throw conflict('Only an allocated unit can be collected.', 'RESERVATION_TRANSITION_NOT_ALLOWED');
      const s = await this.sponsorship(db, r.sponsorshipId);
      const [ver] = s.approvedVersionId ? await tx.select().from(dropSponsorshipVersions).where(eq(dropSponsorshipVersions.id, s.approvedVersionId)).limit(1) : [];
      const now = new Date();
      if (!ver || now < ver.collectionWindowStart || now >= ver.collectionWindowEnd) throw conflict('Collection is only possible inside the published collection window.', 'COLLECTION_WINDOW_CLOSED');
      await tx.update(dropReservations).set({ status: 'collected' }).where(eq(dropReservations.id, r.id));
      await this.append(db, r.sponsorshipId, { type: 'collected', reservationId: r.id, verifiedByUserId: ctx.actorUserId }, ctx);
      return { status: 'collected' as const, created: true };
    });
  }

  /** Releases holds whose time has passed (returns units to the pool) and expires uncollected allocations after the collection window. */
  async expireDue(sponsorshipId: string, ctx: Actor) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db; let holds = 0; let uncollected = 0;
      const due = await tx.select().from(dropReservations).where(and(eq(dropReservations.sponsorshipId, sponsorshipId), eq(dropReservations.status, 'reserved'), sql`${dropReservations.holdExpiresAt} <= now()`)).for('update');
      for (const r of due) { await tx.update(dropReservations).set({ status: 'expired', statusReason: 'hold expired' }).where(eq(dropReservations.id, r.id)); await this.append(db, sponsorshipId, { type: 'hold_expired', reservationId: r.id }, ctx); holds++; }
      const s = await this.sponsorship(db, sponsorshipId);
      const [ver] = s.approvedVersionId ? await tx.select().from(dropSponsorshipVersions).where(eq(dropSponsorshipVersions.id, s.approvedVersionId)).limit(1) : [];
      if (ver && ver.collectionWindowEnd <= new Date()) {
        const open = await tx.select().from(dropReservations).where(and(eq(dropReservations.sponsorshipId, sponsorshipId), eq(dropReservations.status, 'allocated'))).for('update');
        for (const r of open) { await tx.update(dropReservations).set({ status: 'expired', statusReason: 'collection window passed' }).where(eq(dropReservations.id, r.id)); await this.append(db, sponsorshipId, { type: 'allocation_expired', reservationId: r.id }, ctx); uncollected++; }
      }
      return { holdsExpired: holds, allocationsExpired: uncollected };
    });
  }

  /** TENANT-SCOPED read for a sponsor: only that business's own sponsorships and aggregate counts; never another business, never customer identities. */
  async listForBusiness(businessId: string) {
    const rows = await this.db.select({ id: dropSponsorships.id, key: dropSponsorships.key, status: dropSponsorships.status, total: dropInventory.totalQuantity, reserved: dropInventory.reserved, allocated: dropInventory.allocated, collected: dropInventory.collected, expired: dropInventory.expired })
      .from(dropSponsorships).leftJoin(dropInventory, eq(dropInventory.sponsorshipId, dropSponsorships.id)).where(eq(dropSponsorships.businessId, businessId)).orderBy(asc(dropSponsorships.createdAt));
    return rows.map((r) => ({ id: r.id, key: r.key, status: r.status, inventory: r.total === null ? null : { total: r.total, reserved: r.reserved, allocated: r.allocated, collected: r.collected, expired: r.expired, available: r.total - (r.reserved ?? 0) - (r.allocated ?? 0) - (r.collected ?? 0) - (r.expired ?? 0) } }));
  }

  async verifyEvidence(sponsorshipId: string) {
    const links = await this.db.select().from(dropEvents).where(eq(dropEvents.sponsorshipId, sponsorshipId)).orderBy(asc(dropEvents.seq));
    const chain: AuditLink[] = links.map((l) => ({ prev: l.prevHash, hash: l.hash, event: l.event }));
    const [inv] = await this.db.select().from(dropInventory).where(eq(dropInventory.sponsorshipId, sponsorshipId)).limit(1);
    const counts = await this.db.select({ status: dropReservations.status, n: sql<number>`count(*)::int` }).from(dropReservations).where(eq(dropReservations.sponsorshipId, sponsorshipId)).groupBy(dropReservations.status);
    const by = (s: string) => Number(counts.find((c) => c.status === s)?.n ?? 0);
    const allocExpired = links.filter((l) => l.event.type === 'allocation_expired').length;
    const inventoryConsistent = !inv || (inv.reserved === by('reserved') && inv.allocated === by('allocated') && inv.collected === by('collected') && inv.expired === allocExpired && inv.reserved + inv.allocated + inv.collected + inv.expired <= inv.totalQuantity);
    return { events: links.length, chainOk: links.every((l, i) => l.seq === i + 1) && verifyChain(chain), inventoryConsistent };
  }
}
