import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLog, customerReferralEvents, customerReferrals, qualificationEvidenceConsumptions, qualificationRuleVersions, type ReferralEventType } from '../db/schema';
import { AppError } from '../lib/errors';
import { evaluateQualification, parseQualificationSpec, QualificationSpecError, type PathwayMeasure } from './qualification-spec';
import { measureRecordedPurchases } from './qualification-evidence';

export const CUSTOMER_REFERRAL_RULE_KEY = 'customer_referral_qualification';
const refErr = (code: string, message: string, status: 400 | 404 | 409 | 422 | 503 = 409) => new AppError(message, status, code);

/** Maps the database guard's messages to stable application errors. */
function translate(error: unknown): unknown {
  const text = String((error as { cause?: { message?: string }; message?: string })?.cause?.message ?? (error as Error)?.message ?? '');
  if (/REFERRAL_VERIFICATION_REQUIRES_APPROVED_RULE/.test(text)) return refErr('QUALIFICATION_NOT_APPROVED', 'No approved qualification rule allows this.');
  if (/REFERRAL_TRANSITION_NOT_ALLOWED/.test(text)) return refErr('REFERRAL_TRANSITION_NOT_ALLOWED', 'That referral state change is not allowed.');
  if (/customer_referral_events_one_verified_uq|duplicate key value/.test(text)) return refErr('REFERRAL_ALREADY_VERIFIED', 'This referral is already verified.');
  return error;
}

/**
 * TSH-02: referral attribution and lifecycle. EVIDENCE FOUNDATION ONLY: nothing here pays, awards or enters anyone into anything. A referral can reach
 * `verified` only when an APPROVED rule version exists (the database refuses otherwise), and no route in this block approves one, so final
 * qualification is disabled until the Owner approves the definition. A link click, QR scan, invitation creation, unverified registration or any
 * client-generated event is never evidence: attribution comes from a server-side record (an invitation acceptance, or a referral token that does not
 * exist yet), and verification only from measured server evidence.
 */

/** Facts true when the referred customer was attributed, recorded as evidence and never rewritten. */
async function acquisitionFacts(tx: Db, customerId: string, businessId: string | null) {
  const r = await tx.execute<{ other_memberships: number; purchases: number }>(sql`
    select (select count(*)::int from business_customer_memberships where customer_id = ${customerId} and (${businessId}::uuid is null or business_id <> ${businessId}::uuid)) as other_memberships,
           (select count(*)::int from loyalty_purchase_events where customer_id = ${customerId}) as purchases`);
  const row = r.rows?.[0] ?? { other_memberships: 0, purchases: 0 };
  return { newToPlatform: Number(row.other_memberships) === 0 && Number(row.purchases) === 0, priorPurchases: Number(row.purchases) };
}

/**
 * Called INSIDE the customer's join transaction for an invitation acceptance (cashier-assisted or owner-issued). Idempotent: a customer is attributed
 * at most once, ever (database unique), so a second business's invitation never re-attributes them. It records a BUSINESS INVITATION: an acquisition
 * channel, never a customer referral.
 */
export async function recordBusinessInvitationAttribution(
  tx: Db, input: { customerId: string; businessId: string; provenanceKind: 'owner_invitation' | 'cashier_assisted_invitation'; provenanceRef: string },
): Promise<{ recorded: boolean }> {
  const facts = await acquisitionFacts(tx, input.customerId, input.businessId);
  const [row] = await tx.insert(customerReferrals).values({
    referralType: 'business_invitation', referredCustomerId: input.customerId, businessId: input.businessId,
    provenanceKind: input.provenanceKind, provenanceRef: input.provenanceRef,
  }).onConflictDoNothing().returning({ id: customerReferrals.id });
  if (!row) return { recorded: false };
  await tx.insert(customerReferralEvents).values({ referralId: row.id, seq: 1, eventType: 'attributed', evidence: { ...facts, source: input.provenanceKind } });
  return { recorded: true };
}

export class ReferralService {
  constructor(private readonly db: Db) {}

  /**
   * Customer referral attribution. NO public route calls this: no customer referral-link mechanism exists or is approved. It is the single trusted
   * server entry for a future one, and it enforces the identity rules now: distinct customers, an eligible referrer, a referred customer who is new
   * to the platform (no other memberships, no purchases), and one attribution per referred customer ever.
   */
  async attributeCustomerReferral(input: { referrerCustomerId: string; referredCustomerId: string; provenanceRef: string }) {
    if (input.referrerCustomerId === input.referredCustomerId) throw refErr('SELF_REFERRAL', 'A customer cannot refer themselves.', 422);
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute<{ id: string; status: string; verified: boolean }>(sql`
        select c.id, c.status, (c.phone_verified_at is not null or exists (select 1 from customer_credentials cc where cc.customer_id = c.id and cc.login_email_verified_at is not null)) as verified
        from customers c where c.id in (${input.referrerCustomerId}, ${input.referredCustomerId})`);
      const byId = new Map((rows.rows ?? []).map((r) => [r.id, r]));
      const referrer = byId.get(input.referrerCustomerId); const referred = byId.get(input.referredCustomerId);
      if (!referrer || referrer.status !== 'active' || !referrer.verified) throw refErr('REFERRER_INELIGIBLE', 'The referring customer is not eligible.', 422);
      if (!referred || referred.status !== 'active') throw refErr('REFERRED_INELIGIBLE', 'The referred customer is not eligible.', 422);
      const facts = await acquisitionFacts(tx, input.referredCustomerId, null);
      if (!facts.newToPlatform) throw refErr('REFERRED_NOT_NEW', 'The referred customer already has activity on the platform.', 422);
      const [row] = await tx.insert(customerReferrals).values({
        referralType: 'customer_referral', referringCustomerId: input.referrerCustomerId, referredCustomerId: input.referredCustomerId,
        provenanceKind: 'customer_referral_token', provenanceRef: input.provenanceRef,
      }).onConflictDoNothing().returning({ id: customerReferrals.id });
      if (!row) throw refErr('ALREADY_ATTRIBUTED', 'This customer already has an attribution.');
      await tx.insert(customerReferralEvents).values({ referralId: row.id, seq: 1, eventType: 'attributed', evidence: { ...facts, source: 'customer_referral_token' } });
      await tx.insert(auditLog).values({ businessId: null, actorUserId: null, action: 'referral.attributed', entityType: 'customer_referral', entityId: row.id, metadata: { outcome: 'success', referralType: 'customer_referral' } });
      return { referralId: row.id };
    });
  }

  async currentState(referralId: string): Promise<{ seq: number; eventType: ReferralEventType } | null> {
    const [e] = await this.db.select({ seq: customerReferralEvents.seq, eventType: customerReferralEvents.eventType }).from(customerReferralEvents)
      .where(eq(customerReferralEvents.referralId, referralId)).orderBy(desc(customerReferralEvents.seq)).limit(1);
    return e ?? null;
  }

  /** One serialised, validated, auditable step. The database refuses any transition the lifecycle does not allow. */
  async advance(referralId: string, eventType: Exclude<ReferralEventType, 'attributed'>, opts: { reasonCode?: string; evidence?: Record<string, unknown>; actorUserId?: string | null; ruleVersionId?: string | null } = {}) {
    try {
      return await this.db.transaction(async (tx) => {
        const [ref] = await tx.select({ id: customerReferrals.id }).from(customerReferrals).where(eq(customerReferrals.id, referralId)).for('update').limit(1);
        if (!ref) throw refErr('REFERRAL_NOT_FOUND', 'Referral not found.', 404);
        const [cur] = await tx.select({ seq: customerReferralEvents.seq, eventType: customerReferralEvents.eventType }).from(customerReferralEvents)
          .where(eq(customerReferralEvents.referralId, referralId)).orderBy(desc(customerReferralEvents.seq)).limit(1);
        if (cur?.eventType === eventType) return { seq: cur.seq, eventType, created: false }; // idempotent repeat
        const seq = (cur?.seq ?? 0) + 1;
        await tx.insert(customerReferralEvents).values({ referralId, seq, eventType, reasonCode: opts.reasonCode ?? null, evidence: opts.evidence ?? {}, actorUserId: opts.actorUserId ?? null, ruleVersionId: opts.ruleVersionId ?? null });
        await tx.insert(auditLog).values({ businessId: null, actorUserId: opts.actorUserId ?? null, action: `referral.${eventType}`, entityType: 'customer_referral', entityId: referralId, metadata: { outcome: 'success', seq, reasonCode: opts.reasonCode ?? null } });
        return { seq, eventType, created: true };
      });
    } catch (e) { throw translate(e); }
  }

  /**
   * Final qualification. Fails CLOSED: with no APPROVED rule version for the key this throws QUALIFICATION_NOT_APPROVED and records nothing.
   * With one, it evaluates the closed spec against measured server evidence, consumes that evidence (so it can never qualify twice) and appends
   * `verified`, all in one transaction under a per-referral lock; concurrent callers collapse to one outcome.
   */
  async qualify(referralId: string): Promise<{ verified: boolean; reason?: string }> {
    const [rule] = await this.db.select().from(qualificationRuleVersions)
      .where(and(eq(qualificationRuleVersions.ruleKey, CUSTOMER_REFERRAL_RULE_KEY), eq(qualificationRuleVersions.approvalState, 'approved'))).limit(1);
    if (!rule) throw refErr('QUALIFICATION_NOT_APPROVED', 'No approved referral qualification rule exists.');
    let spec;
    try { spec = parseQualificationSpec(rule.spec); } catch (e) { if (e instanceof QualificationSpecError) throw refErr('QUALIFICATION_RULE_INVALID', e.message, 503); throw e; }
    try {
      return await this.db.transaction(async (tx) => {
        const [ref] = await tx.select().from(customerReferrals).where(eq(customerReferrals.id, referralId)).for('update').limit(1);
        if (!ref) throw refErr('REFERRAL_NOT_FOUND', 'Referral not found.', 404);
        const allowed = spec.referralTypes ?? ['customer_referral'];
        if (!allowed.includes(ref.referralType)) return { verified: false, reason: 'REFERRAL_TYPE_NOT_ELIGIBLE' };
        const [cur] = await tx.select({ seq: customerReferralEvents.seq, eventType: customerReferralEvents.eventType }).from(customerReferralEvents)
          .where(eq(customerReferralEvents.referralId, referralId)).orderBy(desc(customerReferralEvents.seq)).limit(1);
        if (!cur) return { verified: false, reason: 'NO_ATTRIBUTION' };
        if (cur.eventType === 'verified') return { verified: true };
        if (!['attributed', 'pending_qualification'].includes(cur.eventType)) return { verified: false, reason: 'STATE_NOT_QUALIFIABLE' };
        const [people] = (await tx.execute<{ referred_ok: boolean; referrer_ok: boolean }>(sql`
          select (select status = 'active' from customers where id = ${ref.referredCustomerId}) as referred_ok,
                 (${ref.referringCustomerId}::uuid is null or (select status = 'active' from customers where id = ${ref.referringCustomerId}::uuid)) as referrer_ok`)).rows ?? [];
        if (!people?.referred_ok || !people.referrer_ok) return { verified: false, reason: 'CUSTOMER_NOT_ELIGIBLE' };
        const measures: PathwayMeasure[] = [];
        for (const p of spec.pathways) {
          measures.push(p.metric === 'recorded_purchases'
            ? await measureRecordedPurchases(tx as unknown as Db, { customerId: ref.referredCustomerId, pathway: p, ruleVersionId: rule.id, consumerKind: 'referral', since: ref.attributedAt })
            : { observed: 1, evidenceIds: [ref.id] });
        }
        const outcome = evaluateQualification(spec, measures);
        let seq = cur.seq;
        if (cur.eventType === 'attributed') {
          seq += 1;
          await tx.insert(customerReferralEvents).values({ referralId, seq, eventType: 'pending_qualification', evidence: {}, ruleVersionId: rule.id });
        }
        if (!outcome.qualified) return { verified: false, reason: 'EVIDENCE_NOT_SUFFICIENT' };
        const purchaseIds = outcome.evidenceIds.filter((id) => id !== ref.id);
        for (const id of purchaseIds) {
          await tx.insert(qualificationEvidenceConsumptions).values({ evidenceKind: 'purchase_event', evidenceId: id, ruleVersionId: rule.id, consumerKind: 'referral', consumerRef: referralId });
        }
        await tx.insert(customerReferralEvents).values({ referralId, seq: seq + 1, eventType: 'verified', ruleVersionId: rule.id, evidence: { ruleVersionId: rule.id, specHash: rule.specHash, purchaseEvidenceIds: purchaseIds, evidenceLevel: 'recorded' } });
        await tx.insert(auditLog).values({ businessId: null, actorUserId: null, action: 'referral.verified', entityType: 'customer_referral', entityId: referralId, metadata: { outcome: 'success', ruleVersionId: rule.id } });
        return { verified: true };
      });
    } catch (e) { throw translate(e); }
  }
}
