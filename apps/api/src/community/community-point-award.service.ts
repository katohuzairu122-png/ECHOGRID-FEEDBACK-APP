import { sql } from 'drizzle-orm';
import type { Database, Db } from '../db/client';
import { communityPointAccounts } from '../db/schema';
import {
  createRepositories,
  type CommunityPointAccount,
  type CommunityPointAwardDecision,
  type CommunityPointRule,
  type CommunityPointTransaction,
} from '../repositories';
import { AppError } from '../lib/errors';
import { SurveyCompletionEvidenceService } from '../surveys/survey-completion-evidence.service';

export interface CommunityPointAwardResult {
  decision: CommunityPointAwardDecision;
  transaction: CommunityPointTransaction | null;
  account: CommunityPointAccount | null;
  awarded: boolean;
  pendingMembership: boolean;
}

export class CommunityPointAwardService {
  constructor(private readonly db: Database) {}

  async evaluateSurveyCompletion(
    completionRef: string,
  ): Promise<CommunityPointAwardResult> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const evidence = await new SurveyCompletionEvidenceService(repos).getByCompletionRef(
        completionRef,
      );

      const rule = await this.resolveRule(repos, evidence.campaignId);
      if (!rule) {
        throw new AppError(
          'No active Community Point rule applies to this survey completion.',
          409,
          'COMMUNITY_POINT_RULE_NOT_ACTIVE',
        );
      }

      const existing = await repos.communityPointAwardDecisions.findBySourceRule(
        'survey_completion',
        evidence.completionRef,
        rule.id,
      );

      if (existing?.status === 'awarded') {
        const transaction = await repos.communityPointTransactions.findByAwardDecision(
          existing.id,
        );
        const account = existing.accountId
          ? await repos.communityPointAccounts.findById(existing.accountId)
          : undefined;
        if (!transaction || !account) {
          throw new AppError(
            'Award state is inconsistent with its ledger record.',
            409,
            'COMMUNITY_AWARD_STATE_CONFLICT',
          );
        }
        return {
          decision: existing,
          transaction,
          account,
          awarded: false,
          pendingMembership: false,
        };
      }

      if (existing?.status === 'reversed' || existing?.status === 'rejected') {
        return {
          decision: existing,
          transaction: null,
          account: existing.accountId
            ? (await repos.communityPointAccounts.findById(existing.accountId)) ?? null
            : null,
          awarded: false,
          pendingMembership: false,
        };
      }

      const membership = await repos.communityMemberships.findActiveByCustomerId(
        evidence.participantCustomerId,
      );

      if (!membership) {
        const { decision } = existing
          ? { decision: existing }
          : await repos.communityPointAwardDecisions.createIdempotent({
              customerId: evidence.participantCustomerId,
              accountId: null,
              sourceType: 'survey_completion',
              sourceRef: evidence.completionRef,
              ruleId: rule.id,
              status: 'pending_membership',
              points: rule.points,
              reasonCode: 'community_membership_required',
              evaluatedAt: new Date(),
            });

        return {
          decision,
          transaction: null,
          account: null,
          awarded: false,
          pendingMembership: true,
        };
      }

      return this.awardDecision(tx, repos, {
        customerId: evidence.participantCustomerId,
        completionRef: evidence.completionRef,
        businessId: evidence.businessId,
        branchId: evidence.branchId,
        rule,
        existingDecision: existing,
      });
    });
  }

  async reevaluatePendingMembership(customerId: string): Promise<CommunityPointAwardResult[]> {
    const pending = await createRepositories(this.db).communityPointAwardDecisions
      .listPendingMembershipForCustomer(customerId);

    const results: CommunityPointAwardResult[] = [];
    for (const decision of pending) {
      results.push(await this.reevaluatePendingDecision(decision.id, customerId));
    }
    return results;
  }

  private async reevaluatePendingDecision(
    decisionId: string,
    customerId: string,
  ): Promise<CommunityPointAwardResult> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const decision = await repos.communityPointAwardDecisions.findById(decisionId);
      if (!decision || decision.customerId !== customerId) {
        throw new AppError(
          'Pending Community Point decision not found.',
          404,
          'COMMUNITY_AWARD_DECISION_NOT_FOUND',
        );
      }

      if (decision.status !== 'pending_membership') {
        if (decision.status === 'awarded') {
          const transaction = await repos.communityPointTransactions.findByAwardDecision(
            decision.id,
          );
          const account = decision.accountId
            ? await repos.communityPointAccounts.findById(decision.accountId)
            : undefined;
          if (!transaction || !account) {
            throw new AppError(
              'Award state is inconsistent with its ledger record.',
              409,
              'COMMUNITY_AWARD_STATE_CONFLICT',
            );
          }
          return {
            decision,
            transaction,
            account,
            awarded: false,
            pendingMembership: false,
          };
        }
        return {
          decision,
          transaction: null,
          account: decision.accountId
            ? (await repos.communityPointAccounts.findById(decision.accountId)) ?? null
            : null,
          awarded: false,
          pendingMembership: false,
        };
      }

      const rule = await repos.communityPointRules.isActiveNow(decision.ruleId);
      if (!rule) {
        const rejected = await repos.communityPointAwardDecisions.updateOutcome(
          decision.id,
          {
            status: 'rejected',
            reasonCode: 'rule_no_longer_active',
            evaluatedAt: new Date(),
          },
        );
        if (!rejected) {
          throw new AppError(
            'Pending Community Point decision could not be updated.',
            409,
            'COMMUNITY_AWARD_STATE_CONFLICT',
          );
        }
        return {
          decision: rejected,
          transaction: null,
          account: null,
          awarded: false,
          pendingMembership: false,
        };
      }

      const evidence = await new SurveyCompletionEvidenceService(repos).getByCompletionRef(
        decision.sourceRef,
      );
      if (evidence.participantCustomerId !== customerId) {
        throw new AppError(
          'Survey completion evidence does not belong to this customer.',
          409,
          'COMMUNITY_AWARD_EVIDENCE_MISMATCH',
        );
      }

      const membership = await repos.communityMemberships.findActiveByCustomerId(customerId);
      if (!membership) {
        return {
          decision,
          transaction: null,
          account: null,
          awarded: false,
          pendingMembership: true,
        };
      }

      return this.awardDecision(tx, repos, {
        customerId,
        completionRef: evidence.completionRef,
        businessId: evidence.businessId,
        branchId: evidence.branchId,
        rule,
        existingDecision: decision,
      });
    });
  }

  private async resolveRule(
    repos: ReturnType<typeof createRepositories>,
    campaignId: string,
  ): Promise<CommunityPointRule | undefined> {
    const scoped = await repos.communityPointRules.findActiveForResource(
      'survey_completion',
      'survey_campaign',
      campaignId,
    );
    if (scoped) return scoped;

    return repos.communityPointRules.findActiveForResource(
      'survey_completion',
      null,
      null,
    );
  }

  private async awardDecision(
    db: Db,
    repos: ReturnType<typeof createRepositories>,
    input: {
      customerId: string;
      completionRef: string;
      businessId: string | null;
      branchId: string | null;
      rule: CommunityPointRule;
      existingDecision?: CommunityPointAwardDecision | undefined;
    },
  ): Promise<CommunityPointAwardResult> {
    let account = await repos.communityPointAccounts.findByCustomerId(input.customerId);
    if (!account || account.status !== 'active') {
      throw new AppError(
        'An active Community Point account is required before points can be awarded.',
        409,
        'COMMUNITY_ACCOUNT_NOT_READY',
      );
    }

    await db.execute(
      sql`select id from ${communityPointAccounts} where ${communityPointAccounts.id} = ${account.id} for update`,
    );
    account = (await repos.communityPointAccounts.findById(account.id)) ?? account;

    const decisionResult = input.existingDecision
      ? { decision: input.existingDecision, inserted: false }
      : await repos.communityPointAwardDecisions.createIdempotent({
          customerId: input.customerId,
          accountId: account.id,
          sourceType: 'survey_completion',
          sourceRef: input.completionRef,
          ruleId: input.rule.id,
          status: 'pending_membership',
          points: input.rule.points,
          reasonCode: null,
          evaluatedAt: new Date(),
        });

    let decision = decisionResult.decision;

    if (decision.status === 'awarded') {
      const transaction = await repos.communityPointTransactions.findByAwardDecision(
        decision.id,
      );
      if (!transaction) {
        throw new AppError(
          'Award state is inconsistent with its ledger record.',
          409,
          'COMMUNITY_AWARD_STATE_CONFLICT',
        );
      }
      return {
        decision,
        transaction,
        account,
        awarded: false,
        pendingMembership: false,
      };
    }

    if (decision.status !== 'pending_membership') {
      return {
        decision,
        transaction: null,
        account,
        awarded: false,
        pendingMembership: false,
      };
    }

    const idempotencyKey = `community-award:${decision.id}`;
    const existingTransaction = await repos.communityPointTransactions.findByIdempotencyKey(
      idempotencyKey,
    );

    if (existingTransaction) {
      if (
        existingTransaction.awardDecisionId !== decision.id ||
        existingTransaction.accountId !== account.id ||
        existingTransaction.customerId !== input.customerId ||
        existingTransaction.points !== decision.points ||
        existingTransaction.type !== 'earn'
      ) {
        throw new AppError(
          'Community Point award idempotency key conflicts with another ledger mutation.',
          409,
          'IDEMPOTENCY_CONFLICT',
        );
      }

      decision =
        (await repos.communityPointAwardDecisions.updateOutcome(decision.id, {
          accountId: account.id,
          status: 'awarded',
          reasonCode: null,
          evaluatedAt: new Date(),
          awardedTransactionId: existingTransaction.id,
        })) ?? decision;

      return {
        decision,
        transaction: existingTransaction,
        account,
        awarded: false,
        pendingMembership: false,
      };
    }

    const { transaction, inserted } =
      await repos.communityPointTransactions.createIdempotent({
        accountId: account.id,
        customerId: input.customerId,
        type: 'earn',
        points: decision.points,
        sourceType: 'survey_completion',
        sourceRef: input.completionRef,
        ruleId: input.rule.id,
        awardDecisionId: decision.id,
        businessId: input.businessId,
        branchId: input.branchId,
        reversalOf: null,
        idempotencyKey,
        metadata: {
          completionRef: input.completionRef,
        },
      });

    if (!inserted) {
      throw new AppError(
        'Community Point award ledger insertion conflicted unexpectedly.',
        409,
        'COMMUNITY_AWARD_STATE_CONFLICT',
      );
    }

    const updatedAccount = await repos.communityPointAccounts.incrementBalance(
      account.id,
      decision.points,
    );
    if (!updatedAccount) {
      throw new AppError(
        'Community Point balance projection could not be updated.',
        409,
        'COMMUNITY_ACCOUNT_CONFLICT',
      );
    }

    const updatedDecision = await repos.communityPointAwardDecisions.updateOutcome(
      decision.id,
      {
        accountId: account.id,
        status: 'awarded',
        reasonCode: null,
        evaluatedAt: new Date(),
        awardedTransactionId: transaction.id,
      },
    );
    if (!updatedDecision) {
      throw new AppError(
        'Community Point award decision could not be finalized.',
        409,
        'COMMUNITY_AWARD_STATE_CONFLICT',
      );
    }

    return {
      decision: updatedDecision,
      transaction,
      account: updatedAccount,
      awarded: true,
      pendingMembership: false,
    };
  }
}
