import type { Db } from '../db/client';
import { BusinessRepository } from './business.repository';
import { BranchRepository } from './branch.repository';
import { UserRepository } from './user.repository';
import { RoleRepository } from './role.repository';
import { UserBusinessRoleRepository } from './user-business-role.repository';
import { RefreshTokenRepository } from './refresh-token.repository';
import { PermissionRepository } from './permission.repository';
import { AuditLogRepository } from './audit-log.repository';
import { QrCodeRepository } from './qr-code.repository';
import { FeedbackRepository } from './feedback.repository';
import { FeedbackSummaryRepository } from './feedback-summary.repository';
import { CustomerRepository } from './customer.repository';
import { OtpCodeRepository } from './otp-code.repository';
import { LoyaltyTierRepository } from './loyalty-tier.repository';
import { LoyaltyRewardRepository } from './loyalty-reward.repository';
import { LoyaltyAccountRepository } from './loyalty-account.repository';
import { LoyaltyTransactionRepository } from './loyalty-transaction.repository';
import { LoyaltySettingsRepository } from './loyalty-settings.repository';
import { NotificationPreferenceRepository } from './notification-preference.repository';
import { NotificationRepository } from './notification.repository';
import { BusinessNotificationSettingsRepository } from './business-notification-settings.repository';
import { SubscriptionPlanRepository } from './subscription-plan.repository';
import { BusinessSubscriptionRepository } from './business-subscription.repository';
import { ConversationRepository } from './conversation.repository';
import { MessageRepository } from './message.repository';

export * from './business.repository';
export * from './branch.repository';
export * from './user.repository';
export * from './role.repository';
export * from './user-business-role.repository';
export * from './refresh-token.repository';
export * from './permission.repository';
export * from './audit-log.repository';
export * from './qr-code.repository';
export * from './feedback.repository';
export * from './feedback-summary.repository';
export * from './customer.repository';
export * from './otp-code.repository';
export * from './loyalty-tier.repository';
export * from './loyalty-reward.repository';
export * from './loyalty-account.repository';
export * from './loyalty-transaction.repository';
export * from './loyalty-settings.repository';
export * from './notification-preference.repository';
export * from './notification.repository';
export * from './business-notification-settings.repository';
export * from './subscription-plan.repository';
export * from './business-subscription.repository';
export * from './conversation.repository';
export * from './message.repository';

/**
 * Constructs one instance of every repository, sharing a single
 * request-scoped Database. Block 7 wires this into Hono middleware so route
 * handlers pull repositories off context instead of constructing them ad hoc.
 */
export function createRepositories(db: Db) {
  return {
    businesses: new BusinessRepository(db),
    branches: new BranchRepository(db),
    users: new UserRepository(db),
    roles: new RoleRepository(db),
    userBusinessRoles: new UserBusinessRoleRepository(db),
    refreshTokens: new RefreshTokenRepository(db),
    permissions: new PermissionRepository(db),
    auditLog: new AuditLogRepository(db),
    qrCodes: new QrCodeRepository(db),
    feedback: new FeedbackRepository(db),
    feedbackSummaries: new FeedbackSummaryRepository(db),
    customers: new CustomerRepository(db),
    otpCodes: new OtpCodeRepository(db),
    loyaltyTiers: new LoyaltyTierRepository(db),
    loyaltyRewards: new LoyaltyRewardRepository(db),
    loyaltyAccounts: new LoyaltyAccountRepository(db),
    loyaltyTransactions: new LoyaltyTransactionRepository(db),
    loyaltySettings: new LoyaltySettingsRepository(db),
    notificationPreferences: new NotificationPreferenceRepository(db),
    notifications: new NotificationRepository(db),
    businessNotificationSettings: new BusinessNotificationSettingsRepository(db),
    subscriptionPlans: new SubscriptionPlanRepository(db),
    businessSubscriptions: new BusinessSubscriptionRepository(db),
    conversations: new ConversationRepository(db),
    messages: new MessageRepository(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
