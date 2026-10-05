import { and, eq, sql, desc } from 'drizzle-orm';
import type {
  BranchProgramInput,
  BranchPurchaseInput,
  SubmitFeedbackInput,
} from '@echo-grid-feedback/shared-types';
import type { Database, Db } from '../db/client';
import {
  branchLoyaltyPrograms as programs,
  branchLoyaltyMemberships as memberships,
  branchLoyaltyLedger as ledger,
  customerCommunityChoices as choices,
  businesses,
  branches,
  feedback,
} from '../db/schema';
import type { QrCode } from '../repositories';
import { FeedbackService } from '../feedback/feedback.service';
import { validateFeedbackAnswers } from '../feedback/feedback-form-validator';
import { createRepositories } from '../repositories';
import { AppError } from '../lib/errors';

export const COMMUNITY_POLICY_VERSION = '2026-10-05-v1';
const conflict = () =>
  new AppError(
    'This reference was already used. Check the original transaction.',
    409,
    'REFERENCE_ALREADY_USED',
  );

/** Owns transactions like LoyaltyAccountService. Membership row locks serialize
 * earning, refunds and reservations; ledger SUM is the source of truth. */
export class BranchLoyaltyService {
  constructor(private readonly db: Database) {}

  async program(businessId: string, branchId: string, db: Db = this.db) {
    const query = db
      .select()
      .from(programs)
      .where(and(eq(programs.branchId, branchId), eq(programs.businessId, businessId)));
    const [program] = await (db === this.db ? query : query.for('share'));
    return program;
  }
  async configure(businessId: string, branchId: string, input: BranchProgramInput, actor: string) {
    const branch = await createRepositories(this.db).branches.findById(branchId, businessId);
    if (!branch) throw new AppError('Branch not found.', 404, 'BRANCH_NOT_FOUND');
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(programs)
        .where(eq(programs.branchId, branchId))
        .for('update');
      if (existing) {
        const [activity] = await tx
          .select({ id: ledger.id })
          .from(ledger)
          .where(eq(ledger.branchId, branchId))
          .limit(1);
        if (
          activity &&
          [
            'unitLabel',
            'rewardCost',
            'rewardName',
            'qualifyingPurchaseDescription',
            'feedbackBonusUnits',
          ].some(
            (key) =>
              existing[key as keyof typeof existing] !== input[key as keyof BranchProgramInput],
          )
        ) {
          throw new AppError(
            'This program has earned rewards. Its earning and reward terms need a versioned successor; existing promises cannot be overwritten.',
            409,
            'PROGRAM_TERMS_LOCKED',
          );
        }
      }
      const [program] = await tx
        .insert(programs)
        .values({ ...input, businessId, branchId, createdBy: actor, updatedBy: actor })
        .onConflictDoUpdate({
          target: programs.branchId,
          set: { ...input, updatedBy: actor, updatedAt: new Date() },
        })
        .returning();
      return program;
    });
  }
  async setCommunityChoice(customerId: string, joined: boolean, db: Db = this.db) {
    const [choice] = await db
      .insert(choices)
      .values({ customerId, joined, policyVersion: COMMUNITY_POLICY_VERSION })
      .onConflictDoUpdate({
        target: choices.customerId,
        set: { joined, policyVersion: COMMUNITY_POLICY_VERSION, updatedAt: new Date() },
      })
      .returning();
    return choice;
  }
  async communityChoice(customerId: string) {
    const [choice] = await this.db.select().from(choices).where(eq(choices.customerId, customerId));
    return {
      joined: choice?.joined ?? false,
      policyVersion: choice?.policyVersion ?? COMMUNITY_POLICY_VERSION,
    };
  }
  async join(customerId: string, businessId: string, branchId: string, joinCommunity: boolean) {
    return this.db.transaction(async (tx) => {
      const program = await this.requireEnabled(businessId, branchId, tx);
      if (program.onboardingMode === 'community' && !joinCommunity) {
        throw new AppError(
          'Accept community enrollment to join this program, or continue without joining.',
          422,
          'COMMUNITY_CHOICE_REQUIRED',
        );
      }
      // A branch-only enrollment must not revoke an earlier global opt-in.
      if (joinCommunity) await this.setCommunityChoice(customerId, true, tx);
      const [membership] = await tx
        .insert(memberships)
        .values({ customerId, businessId, branchId })
        .onConflictDoUpdate({
          target: [memberships.customerId, memberships.branchId],
          set: { updatedAt: new Date() },
        })
        .returning();
      return membership;
    });
  }
  async list(customerId: string) {
    return this.db
      .select({
        id: memberships.id,
        businessId: memberships.businessId,
        branchId: memberships.branchId,
        businessName: businesses.name,
        branchName: branches.name,
        activatedAt: memberships.activatedAt,
        units: sql<number>`coalesce((select sum(units) from branch_loyalty_ledger where membership_id = ${memberships.id}), 0)::int`,
        unitLabel: programs.unitLabel,
        rewardName: programs.rewardName,
        rewardCost: programs.rewardCost,
        enabled: programs.enabled,
      })
      .from(memberships)
      .innerJoin(programs, eq(programs.branchId, memberships.branchId))
      .innerJoin(businesses, eq(businesses.id, memberships.businessId))
      .innerJoin(branches, eq(branches.id, memberships.branchId))
      .where(eq(memberships.customerId, customerId))
      .orderBy(desc(memberships.updatedAt));
  }
  async history(customerId: string, membershipId: string) {
    const membership = await this.ownMembership(customerId, membershipId);
    return this.db
      .select({
        id: ledger.id,
        type: ledger.type,
        units: ledger.units,
        createdAt: ledger.createdAt,
        receiptReference: ledger.receiptReference,
        code: ledger.code,
        confirmedAt: ledger.confirmedAt,
        rewardName: ledger.rewardName,
      })
      .from(ledger)
      .where(eq(ledger.membershipId, membership.id))
      .orderBy(desc(ledger.createdAt))
      .limit(100);
  }
  async purchase(businessId: string, branchId: string, input: BranchPurchaseInput, actor: string) {
    try {
      return await this.db.transaction(async (tx) => {
        await this.requireEnabled(businessId, branchId, tx);
        const membership = await this.lockMembership(tx, businessId, branchId, input.membershipId);
        const [previous] = await tx
          .select()
          .from(ledger)
          .where(
            and(
              eq(ledger.businessId, businessId),
              eq(ledger.branchId, branchId),
              eq(ledger.receiptReference, input.receiptReference),
            ),
          );
        if (previous) {
          if (
            previous.membershipId !== membership.id ||
            previous.units !== input.qualifyingUnits ||
            previous.evidence !== input.evidence
          )
            throw conflict();
          return previous;
        }
        const [entry] = await tx
          .insert(ledger)
          .values({
            membershipId: membership.id,
            businessId,
            branchId,
            type: 'purchase',
            units: input.qualifyingUnits,
            receiptReference: input.receiptReference,
            evidence: input.evidence,
            createdBy: actor,
          })
          .returning();
        if (!membership.activatedAt)
          await tx
            .update(memberships)
            .set({ activatedAt: new Date(), updatedAt: new Date(), updatedBy: actor })
            .where(eq(memberships.id, membership.id));
        return entry;
      });
    } catch (err) {
      this.rethrowConflict(err);
    }
  }
  async redeem(customerId: string, membershipId: string, requestId: string) {
    const own = await this.ownMembership(customerId, membershipId);
    return this.db.transaction(async (tx) => {
      const membership = await this.lockMembership(tx, own.businessId, own.branchId, membershipId);
      const [previous] = await tx
        .select()
        .from(ledger)
        .where(and(eq(ledger.membershipId, membershipId), eq(ledger.requestId, requestId)));
      if (previous) return previous;
      const program = await this.requireEnabled(own.businessId, own.branchId, tx);
      if (!membership.activatedAt)
        throw new AppError(
          'A confirmed qualifying purchase is required.',
          422,
          'PURCHASE_REQUIRED',
        );
      if ((await this.balance(tx, membershipId)) < program.rewardCost)
        throw new AppError('Not enough branch rewards.', 422, 'INSUFFICIENT_POINTS');
      const [entry] = await tx
        .insert(ledger)
        .values({
          membershipId,
          businessId: own.businessId,
          branchId: own.branchId,
          type: 'redemption',
          units: -program.rewardCost,
          requestId,
          code: crypto.randomUUID(),
          rewardName: program.rewardName,
        })
        .returning();
      return entry;
    });
  }
  async confirm(businessId: string, branchId: string, code: string, actor: string) {
    return this.db.transaction(async (tx) => {
      const [entry] = await tx
        .select()
        .from(ledger)
        .where(
          and(
            eq(ledger.businessId, businessId),
            eq(ledger.branchId, branchId),
            eq(ledger.code, code),
          ),
        )
        .for('update');
      if (!entry)
        throw new AppError('Redemption not found at this branch.', 404, 'REDEMPTION_NOT_FOUND');
      if (entry.confirmedAt) return entry;
      const [confirmed] = await tx
        .update(ledger)
        .set({ confirmedAt: new Date(), confirmedBy: actor })
        .where(eq(ledger.id, entry.id))
        .returning();
      return confirmed;
    });
  }
  async refund(
    businessId: string,
    branchId: string,
    purchaseId: string,
    reason: string,
    actor: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [purchase] = await tx
        .select()
        .from(ledger)
        .where(
          and(
            eq(ledger.id, purchaseId),
            eq(ledger.businessId, businessId),
            eq(ledger.branchId, branchId),
            eq(ledger.type, 'purchase'),
          ),
        );
      if (!purchase)
        throw new AppError('Purchase not found at this branch.', 404, 'PURCHASE_NOT_FOUND');
      await this.lockMembership(tx, businessId, branchId, purchase.membershipId);
      const [previous] = await tx.select().from(ledger).where(eq(ledger.reversalOf, purchaseId));
      if (previous) return previous;
      const [bonus] = await tx
        .select()
        .from(ledger)
        .where(and(eq(ledger.relatedPurchaseId, purchase.id), eq(ledger.type, 'feedback_bonus')));
      const refundUnits = purchase.units + (bonus?.units ?? 0);
      if ((await this.balance(tx, purchase.membershipId)) < refundUnits) {
        throw new AppError(
          'Rewards from this purchase have been spent or reserved. A reviewed settlement is required.',
          409,
          'REFUND_REQUIRES_REVIEW',
        );
      }
      const [entry] = await tx
        .insert(ledger)
        .values({
          membershipId: purchase.membershipId,
          businessId,
          branchId,
          type: 'refund',
          units: -purchase.units,
          reversalOf: purchaseId,
          evidence: reason,
          createdBy: actor,
        })
        .returning();
      if (bonus)
        await tx.insert(ledger).values({
          membershipId: purchase.membershipId,
          businessId,
          branchId,
          type: 'refund',
          units: -bonus.units,
          reversalOf: bonus.id,
          evidence: reason,
          createdBy: actor,
        });
      const [remaining] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(ledger)
        .where(
          and(
            eq(ledger.membershipId, purchase.membershipId),
            eq(ledger.type, 'purchase'),
            sql`not exists (select 1 from branch_loyalty_ledger r where r.reversal_of = ${ledger.id})`,
          ),
        );
      if (remaining?.count === 0)
        await tx
          .update(memberships)
          .set({ activatedAt: null, updatedAt: new Date(), updatedBy: actor })
          .where(eq(memberships.id, purchase.membershipId));
      return entry;
    });
  }
  async directory() {
    return this.db
      .select({
        businessId: businesses.id,
        businessName: businesses.name,
        branchId: branches.id,
        branchName: branches.name,
        qualifyingPurchaseDescription: programs.qualifyingPurchaseDescription,
        rewardName: programs.rewardName,
      })
      .from(programs)
      .innerJoin(businesses, eq(businesses.id, programs.businessId))
      .innerJoin(branches, eq(branches.id, programs.branchId))
      .where(
        and(
          eq(programs.listedInCommunity, true),
          eq(programs.enabled, true),
          eq(businesses.status, 'active'),
          eq(businesses.isDeleted, false),
          eq(branches.status, 'active'),
          eq(branches.isDeleted, false),
        ),
      )
      .limit(200);
  }
  async verifiedFeedback(
    customerId: string,
    qr: QrCode,
    purchaseId: string,
    input: SubmitFeedbackInput,
  ) {
    return this.db.transaction(async (tx) => {
      const program = await this.program(qr.businessId, qr.branchId, tx);
      const [purchase] = await tx
        .select()
        .from(ledger)
        .innerJoin(memberships, eq(memberships.id, ledger.membershipId))
        .where(
          and(
            eq(ledger.id, purchaseId),
            eq(ledger.type, 'purchase'),
            eq(ledger.branchId, qr.branchId),
            eq(ledger.businessId, qr.businessId),
            eq(memberships.customerId, customerId),
          ),
        );
      if (!purchase)
        throw new AppError(
          'A confirmed purchase at this branch is required.',
          422,
          'PURCHASE_REQUIRED',
        );
      await this.lockMembership(
        tx,
        qr.businessId,
        qr.branchId,
        purchase.branch_loyalty_memberships.id,
      );
      const [refunded] = await tx.select().from(ledger).where(eq(ledger.reversalOf, purchaseId));
      if (refunded) throw new AppError('This purchase was refunded.', 422, 'PURCHASE_REFUNDED');
      const payloadHash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input))),
        ),
      )
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const [existing] = await tx
        .select()
        .from(feedback)
        .where(eq(feedback.verifiedPurchaseId, purchaseId));
      if (existing) {
        if (
          existing.submissionKey !== input.submissionKey ||
          existing.submissionPayloadHash !== payloadHash
        )
          throw new AppError(
            'Feedback was already submitted for this purchase.',
            409,
            'PURCHASE_FEEDBACK_EXISTS',
          );
        return { ...existing, wasInserted: false };
      }
      const repos = createRepositories(tx);
      const form = qr.feedbackFormVersionId
        ? await repos.feedbackForms.findPublishedVersion(qr.feedbackFormVersionId, qr.businessId)
        : undefined;
      if (form) {
        if (input.formVersionId !== form.versionId)
          throw new AppError(
            'The feedback form changed. Reload and try again.',
            409,
            'FORM_VERSION_CHANGED',
          );
        validateFeedbackAnswers(form, input.answers ?? []);
      } else if (input.formVersionId || input.answers?.length)
        throw new AppError('Invalid feedback form.', 422, 'INVALID_FORM_ANSWERS');
      const result = await new FeedbackService(repos).submitIdempotent(qr, input, {
        verifiedPurchaseId: purchaseId,
        payloadHash,
      });
      if (result.feedback.verifiedPurchaseId !== purchaseId)
        throw new AppError('Submission reference already used.', 409, 'REFERENCE_ALREADY_USED');
      if (result.inserted && form)
        await repos.feedbackForms.createAnswers(result.feedback.id, form, input.answers ?? []);
      if (result.inserted && program?.enabled && program.feedbackBonusUnits > 0) {
        let canEarn = true;
        try {
          await this.requireEnabled(qr.businessId, qr.branchId, tx);
        } catch (err) {
          if (err instanceof AppError && err.code === 'PROGRAM_UNAVAILABLE') canEarn = false;
          else throw err;
        }
        if (canEarn)
          await tx.insert(ledger).values({
            membershipId: purchase.branch_loyalty_memberships.id,
            businessId: qr.businessId,
            branchId: qr.branchId,
            type: 'feedback_bonus',
            units: program.feedbackBonusUnits,
            relatedPurchaseId: purchaseId,
          });
      }
      return { ...result.feedback, wasInserted: result.inserted };
    });
  }
  private async requireEnabled(businessId: string, branchId: string, db: Db) {
    const program = await this.program(businessId, branchId, db);
    const repos = createRepositories(db);
    const [business, branch, subscription] = await Promise.all([
      repos.businesses.findById(businessId),
      repos.branches.findById(branchId, businessId),
      repos.businessSubscriptions.findByBusiness(businessId),
    ]);
    if (
      !program?.enabled ||
      !business ||
      business.status !== 'active' ||
      !branch ||
      branch.status !== 'active' ||
      (subscription && ['canceled', 'unpaid', 'incomplete_expired'].includes(subscription.status))
    )
      throw new AppError(
        'This branch is not accepting new loyalty activity.',
        422,
        'PROGRAM_UNAVAILABLE',
      );
    return program;
  }
  private async ownMembership(customerId: string, id: string) {
    const [membership] = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, id), eq(memberships.customerId, customerId)));
    if (!membership)
      throw new AppError('Branch membership not found.', 404, 'MEMBERSHIP_NOT_FOUND');
    return membership;
  }
  private async lockMembership(db: Db, businessId: string, branchId: string, id: string) {
    const [membership] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.id, id),
          eq(memberships.businessId, businessId),
          eq(memberships.branchId, branchId),
        ),
      )
      .for('update');
    if (!membership)
      throw new AppError('Branch membership not found.', 404, 'MEMBERSHIP_NOT_FOUND');
    return membership;
  }
  private async balance(db: Db, id: string) {
    const [row] = await db
      .select({ units: sql<number>`coalesce(sum(${ledger.units}), 0)::int` })
      .from(ledger)
      .where(eq(ledger.membershipId, id));
    return row?.units ?? 0;
  }
  private rethrowConflict(err: unknown): never {
    const cause =
      err instanceof Error ? (err as Error & { cause?: { code?: string } }).cause : undefined;
    if (cause?.code === '23505' || (err as { code?: string })?.code === '23505') throw conflict();
    throw err;
  }
}
