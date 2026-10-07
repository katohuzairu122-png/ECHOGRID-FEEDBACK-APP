import { relations } from 'drizzle-orm';
import { businesses } from './businesses';
import { businessCategories } from './business-categories';
import { branches } from './branches';
import { users } from './users';
import { roles } from './roles';
import { permissions } from './permissions';
import { rolePermissions } from './role-permissions';
import { userBusinessRoles } from './user-business-roles';
import { auditLog } from './audit-log';
import { refreshTokens } from './refresh-tokens';
import { passwordResetTokens } from './password-reset-tokens';
import { qrCodes } from './qr-codes';
import { feedback } from './feedback';
import { feedbackSummaries } from './feedback-summaries';
import { aiUsageLog } from './ai-usage-log';
import { criticalIncidents } from './critical-incidents';
import { fraudSignals } from './fraud-signals';
import { customers } from './customers';
import { businessCustomerMemberships } from './business-customer-memberships';
import { consentGrants } from './consent-grants';
import {
  surveys,
  surveyVersions,
  surveyQuestions,
  surveyCampaigns,
  surveyParticipations,
  surveyAnswers,
} from './surveys';
import { customerActionAuthorizations } from './customer-action-authorizations';
import { loyaltyTiers } from './loyalty-tiers';
import { loyaltyRewards } from './loyalty-rewards';
import { loyaltyAccounts } from './loyalty-accounts';
import { loyaltyPurchaseEvents } from './loyalty-purchase-events';
import { loyaltyTransactions } from './loyalty-transactions';
import { loyaltySettings } from './loyalty-settings';
import { notificationPreferences } from './notification-preferences';
import { notifications } from './notifications';
import { businessNotificationSettings } from './business-notification-settings';
import { subscriptionPlans } from './subscription-plans';
import { businessSubscriptions } from './business-subscriptions';
import { conversations } from './conversations';
import { messages } from './messages';
import { teamInvitations } from './team-invitations';

export const businessesRelations = relations(businesses, ({ many, one }) => ({
  branches: many(branches),
  roles: many(roles),
  userBusinessRoles: many(userBusinessRoles),
  auditLogs: many(auditLog),
  qrCodes: many(qrCodes),
  feedback: many(feedback),
  feedbackSummaries: many(feedbackSummaries),
  aiUsageLogs: many(aiUsageLog),
  criticalIncidents: many(criticalIncidents),
  fraudSignals: many(fraudSignals),
  loyaltyTiers: many(loyaltyTiers),
  loyaltyRewards: many(loyaltyRewards),
  loyaltyAccounts: many(loyaltyAccounts),
  customerMemberships: many(businessCustomerMemberships),
  consentGrants: many(consentGrants),
  surveys: many(surveys),
  surveyCampaigns: many(surveyCampaigns),
  surveyParticipations: many(surveyParticipations),
  customerActionAuthorizations: many(customerActionAuthorizations),
  loyaltySettings: many(loyaltySettings),
  notificationPreferences: many(notificationPreferences),
  notifications: many(notifications),
  conversations: many(conversations),
  teamInvitations: many(teamInvitations),
  // one, not many: business_subscriptions_business_id_key enforces exactly
  // one row per business at the DB layer (Billing Block 8).
  subscription: one(businessSubscriptions, {
    fields: [businesses.id],
    references: [businessSubscriptions.businessId],
  }),
}));


export const businessCategoriesRelations = relations(businessCategories, ({ many }) => ({
  businesses: many(businesses),
}));

export const branchesRelations = relations(branches, ({ one, many }) => ({
  business: one(businesses, { fields: [branches.businessId], references: [businesses.id] }),
  userBusinessRoles: many(userBusinessRoles),
  qrCodes: many(qrCodes),
  feedback: many(feedback),
  feedbackSummaries: many(feedbackSummaries),
  aiUsageLogs: many(aiUsageLog),
  criticalIncidents: many(criticalIncidents),
  fraudSignals: many(fraudSignals),
  teamInvitations: many(teamInvitations),
  surveyCampaigns: many(surveyCampaigns),
  surveyParticipations: many(surveyParticipations),
}));

export const usersRelations = relations(users, ({ many }) => ({
  businessRoles: many(userBusinessRoles),
  auditLogs: many(auditLog),
  refreshTokens: many(refreshTokens),
  passwordResetTokens: many(passwordResetTokens),
  notificationPreferences: many(notificationPreferences),
  notifications: many(notifications),
  teamInvitationsSent: many(teamInvitations),
}));

export const rolesRelations = relations(roles, ({ one, many }) => ({
  business: one(businesses, { fields: [roles.businessId], references: [businesses.id] }),
  rolePermissions: many(rolePermissions),
  teamInvitations: many(teamInvitations),
  userBusinessRoles: many(userBusinessRoles),
}));

export const teamInvitationsRelations = relations(teamInvitations, ({ one }) => ({
  business: one(businesses, { fields: [teamInvitations.businessId], references: [businesses.id] }),
  branch: one(branches, { fields: [teamInvitations.branchId], references: [branches.id] }),
  role: one(roles, { fields: [teamInvitations.roleId], references: [roles.id] }),
  inviter: one(users, { fields: [teamInvitations.invitedBy], references: [users.id] }),
}));

export const permissionsRelations = relations(permissions, ({ many }) => ({
  rolePermissions: many(rolePermissions),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, { fields: [rolePermissions.roleId], references: [roles.id] }),
  permission: one(permissions, {
    fields: [rolePermissions.permissionId],
    references: [permissions.id],
  }),
}));

export const userBusinessRolesRelations = relations(userBusinessRoles, ({ one }) => ({
  user: one(users, { fields: [userBusinessRoles.userId], references: [users.id] }),
  business: one(businesses, {
    fields: [userBusinessRoles.businessId],
    references: [businesses.id],
  }),
  branch: one(branches, { fields: [userBusinessRoles.branchId], references: [branches.id] }),
  role: one(roles, { fields: [userBusinessRoles.roleId], references: [roles.id] }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  business: one(businesses, { fields: [auditLog.businessId], references: [businesses.id] }),
  actor: one(users, { fields: [auditLog.actorUserId], references: [users.id] }),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, { fields: [refreshTokens.userId], references: [users.id] }),
}));

export const passwordResetTokensRelations = relations(passwordResetTokens, ({ one }) => ({
  user: one(users, { fields: [passwordResetTokens.userId], references: [users.id] }),
}));

export const qrCodesRelations = relations(qrCodes, ({ one, many }) => ({
  business: one(businesses, { fields: [qrCodes.businessId], references: [businesses.id] }),
  branch: one(branches, { fields: [qrCodes.branchId], references: [branches.id] }),
  feedback: many(feedback),
}));

export const feedbackRelations = relations(feedback, ({ one }) => ({
  business: one(businesses, { fields: [feedback.businessId], references: [businesses.id] }),
  branch: one(branches, { fields: [feedback.branchId], references: [branches.id] }),
  qrCode: one(qrCodes, { fields: [feedback.qrCodeId], references: [qrCodes.id] }),
}));

export const feedbackSummariesRelations = relations(feedbackSummaries, ({ one }) => ({
  business: one(businesses, { fields: [feedbackSummaries.businessId], references: [businesses.id] }),
  branch: one(branches, { fields: [feedbackSummaries.branchId], references: [branches.id] }),
}));

export const aiUsageLogRelations = relations(aiUsageLog, ({ one }) => ({
  business: one(businesses, { fields: [aiUsageLog.businessId], references: [businesses.id] }),
  branch: one(branches, { fields: [aiUsageLog.branchId], references: [branches.id] }),
}));

export const criticalIncidentsRelations = relations(criticalIncidents, ({ one }) => ({
  business: one(businesses, { fields: [criticalIncidents.businessId], references: [businesses.id] }),
  branch: one(branches, { fields: [criticalIncidents.branchId], references: [branches.id] }),
  feedback: one(feedback, { fields: [criticalIncidents.feedbackId], references: [feedback.id] }),
}));

export const fraudSignalsRelations = relations(fraudSignals, ({ one }) => ({
  business: one(businesses, { fields: [fraudSignals.businessId], references: [businesses.id] }),
  branch: one(branches, { fields: [fraudSignals.branchId], references: [branches.id] }),
  feedback: one(feedback, { fields: [fraudSignals.feedbackId], references: [feedback.id] }),
}));

export const customersRelations = relations(customers, ({ many }) => ({
  loyaltyAccounts: many(loyaltyAccounts),
  notificationPreferences: many(notificationPreferences),
  notifications: many(notifications),
  conversations: many(conversations),
}));


export const businessCustomerMembershipsRelations = relations(
  businessCustomerMemberships,
  ({ one }) => ({
    customer: one(customers, {
      fields: [businessCustomerMemberships.customerId],
      references: [customers.id],
    }),
    business: one(businesses, {
      fields: [businessCustomerMemberships.businessId],
      references: [businesses.id],
    }),
  }),
);

export const consentGrantsRelations = relations(consentGrants, ({ one, many }) => ({
  customer: one(customers, { fields: [consentGrants.customerId], references: [customers.id] }),
  business: one(businesses, { fields: [consentGrants.businessId], references: [businesses.id] }),
  surveyParticipations: many(surveyParticipations),
}));

export const customerActionAuthorizationsRelations = relations(
  customerActionAuthorizations,
  ({ one }) => ({
    customer: one(customers, {
      fields: [customerActionAuthorizations.customerId],
      references: [customers.id],
    }),
    business: one(businesses, {
      fields: [customerActionAuthorizations.businessId],
      references: [businesses.id],
    }),
  }),
);

export const surveysRelations = relations(surveys, ({ one, many }) => ({
  business: one(businesses, { fields: [surveys.businessId], references: [businesses.id] }),
  versions: many(surveyVersions),
  campaigns: many(surveyCampaigns),
  participations: many(surveyParticipations),
}));

export const surveyVersionsRelations = relations(surveyVersions, ({ one, many }) => ({
  survey: one(surveys, { fields: [surveyVersions.surveyId], references: [surveys.id] }),
  questions: many(surveyQuestions),
  campaigns: many(surveyCampaigns),
  participations: many(surveyParticipations),
}));

export const surveyQuestionsRelations = relations(surveyQuestions, ({ one, many }) => ({
  version: one(surveyVersions, {
    fields: [surveyQuestions.versionId],
    references: [surveyVersions.id],
  }),
  answers: many(surveyAnswers),
}));

export const surveyCampaignsRelations = relations(surveyCampaigns, ({ one, many }) => ({
  survey: one(surveys, { fields: [surveyCampaigns.surveyId], references: [surveys.id] }),
  version: one(surveyVersions, {
    fields: [surveyCampaigns.surveyVersionId],
    references: [surveyVersions.id],
  }),
  business: one(businesses, {
    fields: [surveyCampaigns.businessId],
    references: [businesses.id],
  }),
  branch: one(branches, { fields: [surveyCampaigns.branchId], references: [branches.id] }),
  participations: many(surveyParticipations),
}));

export const surveyParticipationsRelations = relations(
  surveyParticipations,
  ({ one, many }) => ({
    survey: one(surveys, {
      fields: [surveyParticipations.surveyId],
      references: [surveys.id],
    }),
    version: one(surveyVersions, {
      fields: [surveyParticipations.surveyVersionId],
      references: [surveyVersions.id],
    }),
    campaign: one(surveyCampaigns, {
      fields: [surveyParticipations.campaignId],
      references: [surveyCampaigns.id],
    }),
    participant: one(customers, {
      fields: [surveyParticipations.participantCustomerId],
      references: [customers.id],
    }),
    business: one(businesses, {
      fields: [surveyParticipations.businessId],
      references: [businesses.id],
    }),
    branch: one(branches, {
      fields: [surveyParticipations.branchId],
      references: [branches.id],
    }),
    consentGrant: one(consentGrants, {
      fields: [surveyParticipations.consentGrantId],
      references: [consentGrants.id],
    }),
    answers: many(surveyAnswers),
  }),
);

export const surveyAnswersRelations = relations(surveyAnswers, ({ one }) => ({
  participation: one(surveyParticipations, {
    fields: [surveyAnswers.participationId],
    references: [surveyParticipations.id],
  }),
  question: one(surveyQuestions, {
    fields: [surveyAnswers.questionId],
    references: [surveyQuestions.id],
  }),
}));

export const loyaltyTiersRelations = relations(loyaltyTiers, ({ one, many }) => ({
  business: one(businesses, { fields: [loyaltyTiers.businessId], references: [businesses.id] }),
  loyaltyAccounts: many(loyaltyAccounts),
}));

export const loyaltyRewardsRelations = relations(loyaltyRewards, ({ one, many }) => ({
  business: one(businesses, { fields: [loyaltyRewards.businessId], references: [businesses.id] }),
  transactions: many(loyaltyTransactions),
  purchaseEvents: many(loyaltyPurchaseEvents),
}));

export const loyaltyAccountsRelations = relations(loyaltyAccounts, ({ one, many }) => ({
  customer: one(customers, { fields: [loyaltyAccounts.customerId], references: [customers.id] }),
  business: one(businesses, { fields: [loyaltyAccounts.businessId], references: [businesses.id] }),
  tier: one(loyaltyTiers, { fields: [loyaltyAccounts.tierId], references: [loyaltyTiers.id] }),
  referredBy: one(customers, {
    fields: [loyaltyAccounts.referredByCustomerId],
    references: [customers.id],
  }),
  transactions: many(loyaltyTransactions),
}));

export const loyaltyPurchaseEventsRelations = relations(loyaltyPurchaseEvents, ({ one }) => ({
  business: one(businesses, {
    fields: [loyaltyPurchaseEvents.businessId],
    references: [businesses.id],
  }),
  branch: one(branches, {
    fields: [loyaltyPurchaseEvents.branchId],
    references: [branches.id],
  }),
  customer: one(customers, {
    fields: [loyaltyPurchaseEvents.customerId],
    references: [customers.id],
  }),
  membership: one(businessCustomerMemberships, {
    fields: [loyaltyPurchaseEvents.membershipId],
    references: [businessCustomerMemberships.id],
  }),
  loyaltyAccount: one(loyaltyAccounts, {
    fields: [loyaltyPurchaseEvents.loyaltyAccountId],
    references: [loyaltyAccounts.id],
  }),
}));

export const loyaltyTransactionsRelations = relations(loyaltyTransactions, ({ one }) => ({
  purchaseEvent: one(loyaltyPurchaseEvents, {
    fields: [loyaltyTransactions.purchaseEventId],
    references: [loyaltyPurchaseEvents.id],
  }),
  loyaltyAccount: one(loyaltyAccounts, {
    fields: [loyaltyTransactions.loyaltyAccountId],
    references: [loyaltyAccounts.id],
  }),
  relatedReward: one(loyaltyRewards, {
    fields: [loyaltyTransactions.relatedRewardId],
    references: [loyaltyRewards.id],
  }),
  relatedQrCode: one(qrCodes, {
    fields: [loyaltyTransactions.relatedQrCodeId],
    references: [qrCodes.id],
  }),
  // Continuing Development Block 2 -- the new feedbackId FK (S6.4
  // prerequisite). Same one(feedback, ...) shape as fraudSignalsRelations/
  // criticalIncidentsRelations above already use for their own feedbackId
  // columns.
  feedback: one(feedback, {
    fields: [loyaltyTransactions.feedbackId],
    references: [feedback.id],
  }),
}));

export const loyaltySettingsRelations = relations(loyaltySettings, ({ one }) => ({
  business: one(businesses, { fields: [loyaltySettings.businessId], references: [businesses.id] }),
}));

export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }) => ({
  business: one(businesses, {
    fields: [notificationPreferences.businessId],
    references: [businesses.id],
  }),
  user: one(users, { fields: [notificationPreferences.userId], references: [users.id] }),
  customer: one(customers, {
    fields: [notificationPreferences.customerId],
    references: [customers.id],
  }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  business: one(businesses, { fields: [notifications.businessId], references: [businesses.id] }),
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
  customer: one(customers, { fields: [notifications.customerId], references: [customers.id] }),
}));

export const businessNotificationSettingsRelations = relations(
  businessNotificationSettings,
  ({ one }) => ({
    business: one(businesses, {
      fields: [businessNotificationSettings.businessId],
      references: [businesses.id],
    }),
  }),
);

/** Billing Block 8. */
export const subscriptionPlansRelations = relations(subscriptionPlans, ({ many }) => ({
  subscriptions: many(businessSubscriptions),
}));

export const businessSubscriptionsRelations = relations(businessSubscriptions, ({ one }) => ({
  business: one(businesses, {
    fields: [businessSubscriptions.businessId],
    references: [businesses.id],
  }),
  plan: one(subscriptionPlans, {
    fields: [businessSubscriptions.planId],
    references: [subscriptionPlans.id],
  }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  customer: one(customers, { fields: [conversations.customerId], references: [customers.id] }),
  business: one(businesses, { fields: [conversations.businessId], references: [businesses.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, { fields: [messages.conversationId], references: [conversations.id] }),
}));
