import type { Db } from '../db/client';
import { BusinessRepository } from './business.repository';
import { BusinessCategoryRepository } from './business-category.repository';
import { BranchRepository } from './branch.repository';
import { UserRepository } from './user.repository';
import { RoleRepository } from './role.repository';
import { UserBusinessRoleRepository } from './user-business-role.repository';
import { RefreshTokenRepository } from './refresh-token.repository';
import { PasswordResetTokenRepository } from './password-reset-token.repository';
import { PermissionRepository } from './permission.repository';
import { AuditLogRepository } from './audit-log.repository';
import { QrCodeRepository } from './qr-code.repository';
import { QrScanEventRepository } from './qr-scan-event.repository';
import { FeedbackRepository } from './feedback.repository';
import { FeedbackFormRepository } from './feedback-form.repository';
import { FeedbackSummaryRepository } from './feedback-summary.repository';
import { AiUsageLogRepository } from './ai-usage-log.repository';
import { CriticalIncidentRepository } from './critical-incident.repository';
import { FraudSignalRepository } from './fraud-signal.repository';
import { CustomerRepository } from './customer.repository';
import { CustomerMembershipRepository } from './customer-membership.repository';
import { ConsentGrantRepository } from './consent-grant.repository';
import { CustomerActionAuthorizationRepository } from './customer-action-authorization.repository';
import { OtpCodeRepository } from './otp-code.repository';
import { LoyaltyTierRepository } from './loyalty-tier.repository';
import { LoyaltyRewardRepository } from './loyalty-reward.repository';
import { LoyaltyAccountRepository } from './loyalty-account.repository';
import { LoyaltyPurchaseEventRepository } from './loyalty-purchase-event.repository';
import { LoyaltyTransactionRepository } from './loyalty-transaction.repository';
import { LoyaltySettingsRepository } from './loyalty-settings.repository';
import { NotificationPreferenceRepository } from './notification-preference.repository';
import { NotificationRepository } from './notification.repository';
import { BusinessNotificationSettingsRepository } from './business-notification-settings.repository';
import { SubscriptionPlanRepository } from './subscription-plan.repository';
import { BusinessSubscriptionRepository } from './business-subscription.repository';
import { TeamInvitationRepository } from './team-invitation.repository';
import { ConversationRepository } from './conversation.repository';
import { MessageRepository } from './message.repository';
import { VisitSessionRepository } from './visit-session.repository';
import { SurveyRepository } from './survey.repository';
import { SurveyParticipationRepository } from './survey-participation.repository';
import { CommunityMembershipRepository } from './community-membership.repository';
import { CommunityPointAccountRepository } from './community-point-account.repository';
import { CommunityPointRuleRepository } from './community-point-rule.repository';
import { CommunityPointAwardDecisionRepository } from './community-point-award-decision.repository';
import { CommunityPointTransactionRepository } from './community-point-transaction.repository';
import { OrphanRewardClaimRepository } from './orphan-reward-claim.repository';
import { OrphanSettlementRepository } from './orphan-settlement.repository';
import { OrphanSettlementEventRepository } from './orphan-settlement-event.repository';

export * from './business.repository';
export * from './business-category.repository';
export * from './branch.repository';
export * from './user.repository';
export * from './role.repository';
export * from './user-business-role.repository';
export * from './refresh-token.repository';
export * from './password-reset-token.repository';
export * from './permission.repository';
export * from './audit-log.repository';
export * from './qr-code.repository';
export * from './qr-scan-event.repository';
export * from './feedback.repository';
export * from './feedback-form.repository';
export * from './feedback-summary.repository';
export * from './ai-usage-log.repository';
export * from './critical-incident.repository';
export * from './fraud-signal.repository';
export * from './customer.repository';
export * from './customer-membership.repository';
export * from './consent-grant.repository';
export * from './customer-action-authorization.repository';
export * from './otp-code.repository';
export * from './loyalty-tier.repository';
export * from './loyalty-reward.repository';
export * from './loyalty-account.repository';
export * from './loyalty-purchase-event.repository';
export * from './loyalty-transaction.repository';
export * from './loyalty-settings.repository';
export * from './notification-preference.repository';
export * from './notification.repository';
export * from './business-notification-settings.repository';
export * from './subscription-plan.repository';
export * from './business-subscription.repository';
export * from './team-invitation.repository';
export * from './conversation.repository';
export * from './message.repository';
export * from './visit-session.repository';
export * from './survey.repository';
export * from './survey-participation.repository';
export * from './community-membership.repository';
export * from './community-point-account.repository';
export * from './community-point-rule.repository';
export * from './community-point-award-decision.repository';
export * from './community-point-transaction.repository';
export * from './orphan-reward-claim.repository';
export * from './orphan-settlement.repository';
export * from './orphan-settlement-event.repository';

/**
 * Constructs one instance of every repository, sharing a single
 * request-scoped Database. Block 7 wires this into Hono middleware so route
 * handlers pull repositories off context instead of constructing them ad hoc.
 */
export function createRepositories(db: Db) {
  return {
    businesses: new BusinessRepository(db),
    businessCategories: new BusinessCategoryRepository(db),
    branches: new BranchRepository(db),
    users: new UserRepository(db),
    roles: new RoleRepository(db),
    userBusinessRoles: new UserBusinessRoleRepository(db),
    refreshTokens: new RefreshTokenRepository(db),
    passwordResetTokens: new PasswordResetTokenRepository(db),
    permissions: new PermissionRepository(db),
    auditLog: new AuditLogRepository(db),
    qrCodes: new QrCodeRepository(db),
    qrScanEvents: new QrScanEventRepository(db),
    feedback: new FeedbackRepository(db),
    feedbackForms: new FeedbackFormRepository(db),
    feedbackSummaries: new FeedbackSummaryRepository(db),
    aiUsageLog: new AiUsageLogRepository(db),
    criticalIncidents: new CriticalIncidentRepository(db),
    fraudSignals: new FraudSignalRepository(db),
    customers: new CustomerRepository(db),
    customerMemberships: new CustomerMembershipRepository(db),
    consentGrants: new ConsentGrantRepository(db),
    customerActionAuthorizations: new CustomerActionAuthorizationRepository(db),
    otpCodes: new OtpCodeRepository(db),
    loyaltyTiers: new LoyaltyTierRepository(db),
    loyaltyRewards: new LoyaltyRewardRepository(db),
    loyaltyAccounts: new LoyaltyAccountRepository(db),
    loyaltyPurchaseEvents: new LoyaltyPurchaseEventRepository(db),
    loyaltyTransactions: new LoyaltyTransactionRepository(db),
    loyaltySettings: new LoyaltySettingsRepository(db),
    notificationPreferences: new NotificationPreferenceRepository(db),
    notifications: new NotificationRepository(db),
    businessNotificationSettings: new BusinessNotificationSettingsRepository(db),
    subscriptionPlans: new SubscriptionPlanRepository(db),
    businessSubscriptions: new BusinessSubscriptionRepository(db),
    teamInvitations: new TeamInvitationRepository(db),
    conversations: new ConversationRepository(db),
    messages: new MessageRepository(db),
    visitSessions: new VisitSessionRepository(db),
    surveys: new SurveyRepository(db),
    surveyParticipations: new SurveyParticipationRepository(db),
    communityMemberships: new CommunityMembershipRepository(db),
    communityPointAccounts: new CommunityPointAccountRepository(db),
    communityPointRules: new CommunityPointRuleRepository(db),
    communityPointAwardDecisions: new CommunityPointAwardDecisionRepository(db),
    communityPointTransactions: new CommunityPointTransactionRepository(db),
    orphanRewardClaims: new OrphanRewardClaimRepository(db),
    orphanSettlements: new OrphanSettlementRepository(db),
    orphanSettlementEvents: new OrphanSettlementEventRepository(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;

