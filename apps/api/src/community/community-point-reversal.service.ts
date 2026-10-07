import { sql } from 'drizzle-orm';
import type { Database, Db } from '../db/client';
import { communityPointAccounts } from '../db/schema';
import {
  createRepositories,
  type CommunityPointAccount,
  type CommunityPointAwardDecision,
  type CommunityPointTransaction,
} from '../repositories';
import { AppError } from '../lib/errors';

export interface CommunityPointReversalItem {
  decision: CommunityPointAwardDecision;
  originalTransaction: CommunityPointTransaction;
  reversalTransaction: CommunityPointTransaction;
  account: CommunityPointAccount;
  reversed: boolean;
}

export class CommunityPointReversalService {
  constructor(private readonly db: Database) {}

  async reverseInvalidatedSurveyCompletion(
    completionRef: string,
  ): Promise<CommunityPointReversalItem[]> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const participation = await repos.surveyParticipations.findById(completionRef);

      if (
        !participation ||
        participation.status !== 'invalidated' ||
        participation.invalidatedAt === null
      ) {
        throw new AppError(
          'Survey participation is not invalidated.',
          409,
          'SURVEY_COMPLETION_NOT_INVALIDATED',
        );
      }

      const decisions = await repos.communityPointAwardDecisions.listBySourceRef(
        'survey_completion',
        completionRef,
      );

      const relevant = decisions.filter(
        (decision) => decision.status === 'awarded' || decision.status === 'reversed',
      );

      if (relevant.length === 0) {
        return [];
      }

      const results: CommunityPointReversalItem[] = [];
      for (const decision of relevant) {
        results.push(
          await this.reverseDecision(tx, repos, decision, participation.invalidatedAt),
        );
      }
      return results;
    });
  }

  private async reverseDecision(
    db: Db,
    repos: ReturnType<typeof createRepositories>,
    decision: CommunityPointAwardDecision,
    invalidatedAt: Date,
  ): Promise<CommunityPointReversalItem> {
    if (!decision.accountId || !decision.awardedTransactionId) {
      throw new AppError(
        'Award decision is missing its account or earning transaction.',
        409,
        'COMMUNITY_AWARD_STATE_CONFLICT',
      );
    }

    const original = await repos.communityPointTransactions.findById(
      decision.awardedTransactionId,
    );
    if (
      !original ||
      original.type !== 'earn' ||
      original.awardDecisionId !== decision.id ||
      original.accountId !== decision.accountId ||
      original.customerId !== decision.customerId
    ) {
      throw new AppError(
        'Award decision is inconsistent with its earning ledger entry.',
        409,
        'COMMUNITY_AWARD_STATE_CONFLICT',
      );
    }

    await db.execute(
      sql`select id from ${communityPointAccounts}
          where ${communityPointAccounts.id} = ${decision.accountId}
          for update`,
    );

    const account = await repos.communityPointAccounts.findById(decision.accountId);
    if (!account) {
      throw new AppError(
        'Community Point account not found.',
        409,
        'COMMUNITY_ACCOUNT_CONFLICT',
      );
    }

    const existingReversal = await repos.communityPointTransactions.findReversalOf(
      original.id,
    );
    if (existingReversal) {
      if (
        existingReversal.type !== 'reverse' ||
        existingReversal.accountId !== account.id ||
        existingReversal.customerId !== decision.customerId ||
        existingReversal.points !== -original.points
      ) {
        throw new AppError(
          'Existing Community Point reversal conflicts with the original award.',
          409,
          'COMMUNITY_REVERSAL_CONFLICT',
        );
      }

      let currentDecision = decision;
      if (decision.status !== 'reversed') {
        currentDecision =
          (await repos.communityPointAwardDecisions.updateOutcome(decision.id, {
            status: 'reversed',
            reasonCode: 'source_evidence_invalidated',
            evaluatedAt: new Date(),
          })) ?? decision;
      }

      return {
        decision: currentDecision,
        originalTransaction: original,
        reversalTransaction: existingReversal,
        account,
        reversed: false,
      };
    }

    const idempotencyKey = `community-reversal:${original.id}`;
    const created = await repos.communityPointTransactions.createIdempotent({
      accountId: account.id,
      customerId: decision.customerId,
      type: 'reverse',
      points: -original.points,
      sourceType: 'reversal',
      sourceRef: decision.sourceRef,
      ruleId: decision.ruleId,
      awardDecisionId: decision.id,
      businessId: original.businessId,
      branchId: original.branchId,
      reversalOf: original.id,
      idempotencyKey,
      metadata: {
        completionRef: decision.sourceRef,
        invalidatedAt: invalidatedAt.toISOString(),
      },
    });

    if (!created.inserted) {
      const replay = created.transaction;
      if (
        replay.reversalOf !== original.id ||
        replay.type !== 'reverse' ||
        replay.points !== -original.points
      ) {
        throw new AppError(
          'Community Point reversal idempotency key conflicts with another mutation.',
          409,
          'IDEMPOTENCY_CONFLICT',
        );
      }
    }

    const updatedAccount = created.inserted
      ? await repos.communityPointAccounts.incrementBalance(
          account.id,
          -original.points,
        )
      : account;

    if (!updatedAccount) {
      throw new AppError(
        'Community Point balance projection could not be reversed.',
        409,
        'COMMUNITY_ACCOUNT_CONFLICT',
      );
    }

    const updatedDecision =
      (await repos.communityPointAwardDecisions.updateOutcome(decision.id, {
        status: 'reversed',
        reasonCode: 'source_evidence_invalidated',
        evaluatedAt: new Date(),
      })) ?? decision;

    return {
      decision: updatedDecision,
      originalTransaction: original,
      reversalTransaction: created.transaction,
      account: updatedAccount,
      reversed: created.inserted,
    };
  }
}
