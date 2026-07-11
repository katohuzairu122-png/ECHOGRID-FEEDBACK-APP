import { relations } from 'drizzle-orm';
import { businesses } from './businesses';
import { branches } from './branches';
import { users } from './users';
import { roles } from './roles';
import { permissions } from './permissions';
import { rolePermissions } from './role-permissions';
import { userBusinessRoles } from './user-business-roles';
import { auditLog } from './audit-log';
import { refreshTokens } from './refresh-tokens';
import { qrCodes } from './qr-codes';
import { feedback } from './feedback';
import { feedbackSummaries } from './feedback-summaries';
import { customers } from './customers';
import { loyaltyTiers } from './loyalty-tiers';
import { loyaltyRewards } from './loyalty-rewards';
import { loyaltyAccounts } from './loyalty-accounts';
import { loyaltyTransactions } from './loyalty-transactions';
import { loyaltySettings } from './loyalty-settings';
import { notificationPreferences } from './notification-preferences';
import { notifications } from './notifications';
import { businessNotificationSettings } from './business-notification-settings';
import { subscriptionPlans } from './subscription-plans';
import { businessSubscriptions } from './business-subscriptions';

export const businessesRelations = relations(businesses, ({ many, one }) => ({
  branches: many(branches),
  roles: many(roles),
  userBusinessRoles: many(userBusinessRoles),
  auditLogs: many(auditLog),
  qrCodes: many(qrCodes),
  feedback: many(feedback),
  feedbackSummaries: many(feedbackSummaries),
  loyaltyTiers: many(loyaltyTiers),
  loyaltyRewards: many(loyaltyRewards),
  loyaltyAccounts: many(loyaltyAccounts),
  loyaltySettings: many(loyaltySettings),
  notificationPreferences: many(notificationPreferences),
  notifications: many(notifications),
  // one, not many: business_subscriptions_business_id_key enforces exactly
  // one row per business at the DB layer (Billing Block 8).
  subscription: one(businessSubscriptions, {
    fields: [businesses.id],
    references: [businessSubscriptions.businessId],
  }),
}));

export const branchesRelations = relations(branches, ({ one, many }) => ({
  business: one(businesses, { fields: [branches.businessId], references: [businesses.id] }),
  userBusinessRoles: many(userBusinessRoles),
  qrCodes: many(qrCodes),
  feedback: many(feedback),
  feedbackSummaries: many(feedbackSummaries),
}));

export const usersRelations = relations(users, ({ many }) => ({
  businessRoles: many(userBusinessRoles),
  auditLogs: many(auditLog),
  refreshTokens: many(refreshTokens),
  notificationPreferences: many(notificationPreferences),
  notifications: many(notifications),
}));

export const rolesRelations = relations(roles, ({ one, many }) => ({
  business: one(businesses, { fields: [roles.businessId], references: [businesses.id] }),
  rolePermissions: many(rolePermissions),
  userBusinessRoles: many(userBusinessRoles),
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

export const customersRelations = relations(customers, ({ many }) => ({
  loyaltyAccounts: many(loyaltyAccounts),
  notificationPreferences: many(notificationPreferences),
  notifications: many(notifications),
}));

export const loyaltyTiersRelations = relations(loyaltyTiers, ({ one, many }) => ({
  business: one(businesses, { fields: [loyaltyTiers.businessId], references: [businesses.id] }),
  loyaltyAccounts: many(loyaltyAccounts),
}));

export const loyaltyRewardsRelations = relations(loyaltyRewards, ({ one, many }) => ({
  business: one(businesses, { fields: [loyaltyRewards.businessId], references: [businesses.id] }),
  transactions: many(loyaltyTransactions),
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

export const loyaltyTransactionsRelations = relations(loyaltyTransactions, ({ one }) => ({
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
