import { sql } from 'drizzle-orm';
import type {
  CommunityPointAdminAdjustmentInput,
  CommunityPointAdminReversalInput,
} from '@echo-grid-feedback/shared-types';
import type { Database, Db } from '../db/client';
import { communityPointAccounts } from '../db/schema';
import {
  createRepositories,
  type CommunityPointAccount,
  type CommunityPointTransaction,
} from '../repositories';
import { AppError } from '../lib/errors';

export interface PlatformCommunityAdjustmentAuditContext {
  actorUserId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface CommunityPointAdminMutationResult {
  transaction: CommunityPointTransaction;
  account: CommunityPointAccount;
  changed: boolean;
}

export class CommunityPointAdminAdjustmentService {
  constructor(private readonly db: Database) {}

  async adjust(
    customerId: string,
    input: CommunityPointAdminAdjustmentInput,
    audit: PlatformCommunityAdjustmentAuditContext,
  ): Promise<CommunityPointAdminMutationResult> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const account = await this.lockCustomerAccount(tx, customerId);

      const existing =
        await repos.communityPointTransactions.findByIdempotencyKey(
          input.idempotencyKey,
        );

      if (existing) {
        const reason =
          existing.metadata &&
          typeof existing.metadata.reason === 'string'
            ? existing.metadata.reason
            : null;

        if (
          existing.type !== 'admin_adjustment' ||
          existing.sourceType !== 'admin_adjustment' ||
          existing.accountId !== account.id ||
          existing.customerId !== customerId ||
          existing.points !== input.points ||
          reason !== input.reason
        ) {
          throw new AppError(
            'Community Point adjustment idempotency key conflicts with another mutation.',
            409,
            'IDEMPOTENCY_CONFLICT',
          );
        }

        return { transaction: existing, account, changed: false };
      }

      const created = await repos.communityPointTransactions.createIdempotent({
        accountId: account.id,
        customerId,
        type: 'admin_adjustment',
        points: input.points,
        sourceType: 'admin_adjustment',
        sourceRef: `platform-admin-adjustment:${input.idempotencyKey}`,
        idempotencyKey: input.idempotencyKey,
        metadata: { reason: input.reason },
        createdBy: audit.actorUserId,
      });

      if (!created.inserted) {
        throw new AppError(
          'Community Point adjustment ledger insertion conflicted unexpectedly.',
          409,
          'COMMUNITY_ADJUSTMENT_CONFLICT',
        );
      }

      const updatedAccount = await repos.communityPointAccounts.incrementBalance(
        account.id,
        input.points,
      );
      if (!updatedAccount) {
        throw new AppError(
          'Community Point balance projection could not be updated.',
          409,
          'COMMUNITY_ACCOUNT_CONFLICT',
        );
      }

      await repos.auditLog.record({
        businessId: null,
        actorUserId: audit.actorUserId,
        action: 'community_point.admin_adjusted',
        entityType: 'community_point_transaction',
        entityId: created.transaction.id,
        metadata: {
          customerId,
          accountId: account.id,
          points: input.points,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        },
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent,
      });

      return {
        transaction: created.transaction,
        account: updatedAccount,
        changed: true,
      };
    });
  }

  async reverseAdjustment(
    transactionId: string,
    input: CommunityPointAdminReversalInput,
    audit: PlatformCommunityAdjustmentAuditContext,
  ): Promise<CommunityPointAdminMutationResult> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const original = await repos.communityPointTransactions.findById(transactionId);
      if (!original) {
        throw new AppError(
          'Community Point transaction not found.',
          404,
          'COMMUNITY_POINT_TRANSACTION_NOT_FOUND',
        );
      }

      if (
        original.type !== 'admin_adjustment' ||
        original.sourceType !== 'admin_adjustment'
      ) {
        throw new AppError(
          'Only a platform admin adjustment can be reversed through this endpoint.',
          409,
          'COMMUNITY_ADMIN_REVERSAL_TARGET_INVALID',
        );
      }

      const correctionOf =
        original.metadata && typeof original.metadata.correctionOf === 'string'
          ? original.metadata.correctionOf
          : null;
      if (correctionOf) {
        throw new AppError(
          'A compensating admin adjustment cannot itself be reversed through this endpoint.',
          409,
          'COMMUNITY_ADMIN_REVERSAL_TARGET_INVALID',
        );
      }

      const account = await this.lockAccount(tx, original.accountId);
      if (account.customerId !== original.customerId) {
        throw new AppError(
          'Community Point transaction does not match its account owner.',
          409,
          'COMMUNITY_ACCOUNT_CONFLICT',
        );
      }

      const sourceRef = `admin-adjustment-reversal:${original.id}`;
      const existingCorrection =
        await repos.communityPointTransactions.findAdminAdjustmentBySourceRef(
          sourceRef,
        );

      if (existingCorrection) {
        if (
          existingCorrection.accountId !== original.accountId ||
          existingCorrection.customerId !== original.customerId ||
          existingCorrection.points !== -original.points
        ) {
          throw new AppError(
            'Existing admin adjustment correction conflicts with the original transaction.',
            409,
            'COMMUNITY_ADMIN_REVERSAL_CONFLICT',
          );
        }
        return {
          transaction: existingCorrection,
          account,
          changed: false,
        };
      }

      const existingIdempotent =
        await repos.communityPointTransactions.findByIdempotencyKey(
          input.idempotencyKey,
        );
      if (existingIdempotent) {
        throw new AppError(
          'Community Point reversal idempotency key conflicts with another mutation.',
          409,
          'IDEMPOTENCY_CONFLICT',
        );
      }

      const created = await repos.communityPointTransactions.createIdempotent({
        accountId: original.accountId,
        customerId: original.customerId,
        type: 'admin_adjustment',
        points: -original.points,
        sourceType: 'admin_adjustment',
        sourceRef,
        idempotencyKey: input.idempotencyKey,
        metadata: {
          reason: input.reason,
          correctionOf: original.id,
        },
        createdBy: audit.actorUserId,
      });

      if (!created.inserted) {
        throw new AppError(
          'Community Point admin reversal insertion conflicted unexpectedly.',
          409,
          'COMMUNITY_ADMIN_REVERSAL_CONFLICT',
        );
      }

      const updatedAccount = await repos.communityPointAccounts.incrementBalance(
        account.id,
        -original.points,
      );
      if (!updatedAccount) {
        throw new AppError(
          'Community Point balance projection could not be corrected.',
          409,
          'COMMUNITY_ACCOUNT_CONFLICT',
        );
      }

      await repos.auditLog.record({
        businessId: null,
        actorUserId: audit.actorUserId,
        action: 'community_point.admin_adjustment_reversed',
        entityType: 'community_point_transaction',
        entityId: created.transaction.id,
        metadata: {
          customerId: original.customerId,
          accountId: original.accountId,
          originalTransactionId: original.id,
          points: -original.points,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        },
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent,
      });

      return {
        transaction: created.transaction,
        account: updatedAccount,
        changed: true,
      };
    });
  }

  private async lockCustomerAccount(
    db: Db,
    customerId: string,
  ): Promise<CommunityPointAccount> {
    const repos = createRepositories(db);
    const account = await repos.communityPointAccounts.findByCustomerId(customerId);
    if (!account) {
      throw new AppError(
        'Community Point account not found for this customer.',
        404,
        'COMMUNITY_POINT_ACCOUNT_NOT_FOUND',
      );
    }
    return this.lockAccount(db, account.id);
  }

  private async lockAccount(
    db: Db,
    accountId: string,
  ): Promise<CommunityPointAccount> {
    await db.execute(
      sql`select id from ${communityPointAccounts}
          where ${communityPointAccounts.id} = ${accountId}
          for update`,
    );
    const account = await createRepositories(db).communityPointAccounts.findById(
      accountId,
    );
    if (!account) {
      throw new AppError(
        'Community Point account not found.',
        409,
        'COMMUNITY_ACCOUNT_CONFLICT',
      );
    }
    return account;
  }
}
