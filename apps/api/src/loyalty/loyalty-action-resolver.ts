import type { Bindings } from '../config/env';
import type { Repositories } from '../repositories';
import { AppError } from '../lib/errors';
import { QrCodeService } from '../qr/qr-code.service';
import { verifyCustomerQrToken, isCustomerQrRevoked } from '../qr/customer-qr-token';
import { assertSurveyAudienceEligible } from '../surveys/survey-participation.service';

export type LoyaltyResolvedAction =
  | 'JOIN_LOYALTY'
  | 'OPEN_LOYALTY_CARD'
  | 'VIEW_REWARDS'
  | 'CHECK_IN'
  | 'LEAVE_FEEDBACK'
  | 'TAKE_SURVEY'
  | 'VIEW_ALLOWED_MEMBERSHIP_STATE'
  | 'VALIDATE_PURCHASE'
  | 'GRANT_LOYALTY_PROGRESS'
  | 'REDEEM_REWARD'
  | 'REQUEST_ORPHAN_SETTLEMENT_ACCESS'
  | 'SETTLE_ORPHAN_REWARD';

/**
 * What a cashier sees after scanning a member's QR: the member's card at THIS business only. Deliberately minimal: a first name
 * (never an id, phone or email), the points balance, the tier name, visit count and the active points rewards of this business with
 * whether the balance already covers them. It is returned only to a staff member who may serve loyalty AND only for an active
 * membership at the scanning business, so it can never reveal another business's relationship or any orphan value.
 */
export interface StaffCustomerCard {
  displayName: string;
  points: number;
  tier: { name: string } | null;
  visitCount: number;
  lastVisitAt: string | null;
  rewards: Array<{ id: string; name: string; pointsCost: number; enoughPoints: boolean; pointsNeeded: number }>;
  /** LPC-06: programme rewards this member has earned and not yet received (added by the route, not the resolver). */
  earnedRewards?: Array<{ id: string; name: string; expiresAt: Date | null }>;
}

/** The cashier card lists at most this many rewards (cheapest first); a business rarely has more, and the screen must stay short. */
const STAFF_CARD_MAX_REWARDS = 12;

export interface ResolvedSurveyCampaign {
  campaignId: string;
  surveyId: string;
  surveyVersionId: string;
  name: string;
  audienceClass: string;
}

export class LoyaltyActionResolver {
  constructor(
    private readonly repos: Pick<
      Repositories,
      | 'customers'
      | 'customerMemberships'
      | 'communityMemberships'
      | 'loyaltyAccounts'
      | 'qrCodes'
      | 'fraudSignals'
      | 'surveys'
      | 'businesses'
      | 'orphanRewardClaims'
      | 'loyaltyTiers'
      | 'loyaltyRewards'
    >,
    private readonly secrets: Pick<Bindings, 'QR_TOKEN_SECRET' | 'QR_TOKEN_SECRET_PREVIOUS'>,
  ) {}

  async resolveCustomerForStaff(input: {
    customerQrToken: string;
    businessId: string;
    permissions: Set<string>;
    /** The scanning branch, so a branch-specific reward is listed only where it can be redeemed. */
    branchId?: string | undefined;
  }): Promise<{
    customerId: string;
    loyaltyAccountId: string | null;
    membershipStatus: 'active' | 'none';
    actions: LoyaltyResolvedAction[];
    card: StaffCustomerCard | null;
  }> {
    let payload;
    try {
      payload = await verifyCustomerQrToken(
        input.customerQrToken,
        this.secrets.QR_TOKEN_SECRET,
        this.secrets.QR_TOKEN_SECRET_PREVIOUS,
      );
    } catch {
      throw new AppError('This customer QR code is no longer valid.', 404, 'CUSTOMER_QR_NOT_FOUND');
    }

    const customer = await this.repos.customers.findById(payload.sub);
    if (!customer || customer.status !== 'active' || isCustomerQrRevoked(payload, customer.qrRevocationEpoch)) {
      throw new AppError('This customer QR code is no longer valid.', 404, 'CUSTOMER_QR_NOT_FOUND');
    }

    const membership = await this.repos.customerMemberships.findActive(
      customer.id,
      input.businessId,
    );
    const account = membership
      ? await this.repos.loyaltyAccounts.findByCustomerAndBusiness(customer.id, input.businessId)
      : undefined;

    const actions: LoyaltyResolvedAction[] = [];
    if (membership && account) {
      if (input.permissions.has('loyalty:serve')) actions.push('VIEW_ALLOWED_MEMBERSHIP_STATE');
      if (input.permissions.has('loyalty:serve') && account.status !== 'suspended') {
        actions.push('VALIDATE_PURCHASE', 'GRANT_LOYALTY_PROGRESS', 'REDEEM_REWARD');
      }
    }

    // Split 06: capability only. Never query orphan claims here, otherwise
    // the mere presence/absence of this action would leak whether the scanned
    // customer owns orphan value before consent.
    if (input.permissions.has('settlement:view')) {
      actions.push('REQUEST_ORPHAN_SETTLEMENT_ACCESS');
    }

    const card =
      membership && account && actions.includes('VIEW_ALLOWED_MEMBERSHIP_STATE')
        ? await this.buildStaffCard(customer.fullName, account, input.businessId, input.branchId)
        : null;

    return {
      customerId: customer.id,
      loyaltyAccountId: account?.id ?? null,
      membershipStatus: membership ? 'active' : 'none',
      actions,
      card,
    };
  }

  private async buildStaffCard(
    fullName: string | null | undefined,
    account: { points: number; tierId: string | null; visitCount: number; lastVisitAt: Date | null; status: string },
    businessId: string,
    branchId: string | undefined,
  ): Promise<StaffCustomerCard> {
    const firstName = fullName?.trim().split(/\s+/)[0];
    const tier = account.tierId ? await this.repos.loyaltyTiers.findById(account.tierId, businessId) : undefined;
    const now = Date.now();
    const rewards = (await this.repos.loyaltyRewards.listForBusiness(businessId))
      .filter(
        (reward) =>
          reward.type === 'points' &&
          reward.pointsCost !== null &&
          (reward.branchId === null || reward.branchId === branchId) &&
          (!reward.startDate || reward.startDate.getTime() <= now) &&
          (!reward.expiryDate || reward.expiryDate.getTime() > now),
      )
      .slice(0, STAFF_CARD_MAX_REWARDS)
      .map((reward) => {
        const pointsCost = reward.pointsCost as number;
        const enoughPoints = account.status !== 'suspended' && account.points >= pointsCost;
        return {
          id: reward.id,
          name: reward.name,
          pointsCost,
          enoughPoints,
          pointsNeeded: Math.max(0, pointsCost - account.points),
        };
      });
    return {
      displayName: firstName ? firstName : 'Member',
      points: account.points,
      tier: tier ? { name: tier.name } : null,
      visitCount: account.visitCount,
      lastVisitAt: account.lastVisitAt ? account.lastVisitAt.toISOString() : null,
      rewards,
    };
  }

  async resolveBusinessForCustomer(input: {
    businessQrToken: string;
    customerId: string;
  }): Promise<{
    businessId: string;
    branchId: string;
    loyaltyAccountId: string | null;
    membershipStatus: 'active' | 'none';
    actions: LoyaltyResolvedAction[];
    surveyCampaigns: ResolvedSurveyCampaign[];
  }> {
    const qrCode = await new QrCodeService(this.repos, this.secrets).resolveToken(
      input.businessQrToken,
    );
    const membership = await this.repos.customerMemberships.findActive(
      input.customerId,
      qrCode.businessId,
    );
    const account = membership
      ? await this.repos.loyaltyAccounts.findByCustomerAndBusiness(
          input.customerId,
          qrCode.businessId,
        )
      : undefined;

    const campaigns = await this.repos.surveys.listQrExposedForBusinessBranch(
      qrCode.businessId,
      qrCode.branchId,
    );

    const surveyCampaigns: ResolvedSurveyCampaign[] = [];
    for (const campaign of campaigns) {
      try {
        await assertSurveyAudienceEligible(this.repos, input.customerId, campaign);
      } catch (error) {
        if (
          error instanceof AppError &&
          (error.code === 'SURVEY_PARTICIPANT_INELIGIBLE' ||
            error.code === 'SURVEY_COMMUNITY_AUDIENCE_UNAVAILABLE')
        ) {
          continue;
        }
        throw error;
      }

      surveyCampaigns.push({
        campaignId: campaign.id,
        surveyId: campaign.surveyId,
        surveyVersionId: campaign.surveyVersionId,
        name: campaign.name,
        audienceClass: campaign.audienceClass,
      });
    }

    const receivingBusiness = await this.repos.businesses.findById(qrCode.businessId);
    const actions: LoyaltyResolvedAction[] = ['LEAVE_FEEDBACK'];
    if (!membership || !account) {
      if (
        receivingBusiness?.status === 'active' &&
        (await this.canStartMembership(input.customerId, qrCode.businessId, membership !== undefined))
      ) {
        actions.unshift('JOIN_LOYALTY');
      }
    } else {
      actions.unshift('OPEN_LOYALTY_CARD', 'VIEW_REWARDS');
      if (account.status !== 'suspended' && receivingBusiness?.status === 'active')
        actions.splice(2, 0, 'CHECK_IN');
    }
    if (surveyCampaigns.length > 0) actions.push('TAKE_SURVEY');

    // Split 06: customer-side QR action is eligible only when the scanned
    // business is currently active and the customer owns at least one
    // available orphan claim from a different origin business. No claim ID,
    // reward value, settlement ID, or authorization state is returned.
    const canSettleOrphan =
      receivingBusiness?.status === 'active' &&
      (await this.repos.orphanRewardClaims.existsAvailableForCustomerExcludingBusiness(
        input.customerId,
        qrCode.businessId,
      ));
    if (canSettleOrphan) actions.push('SETTLE_ORPHAN_REWARD');

    return {
      businessId: qrCode.businessId,
      branchId: qrCode.branchId,
      loyaltyAccountId: account?.id ?? null,
      membershipStatus: membership ? 'active' : 'none',
      actions,
      surveyCampaigns,
    };
  }

  /**
   * Whether offering JOIN_LOYALTY can lead to a membership. True with no
   * relationship at all, after the customer left, or for an active member whose
   * account is missing (joining creates it). A suspended, pending,
   * business-exited or closed membership is not the customer's to restart: the
   * join would be refused (MEMBERSHIP_NOT_REACTIVATABLE), so it is not offered.
   */
  private async canStartMembership(
    customerId: string,
    businessId: string,
    hasActiveMembership: boolean,
  ): Promise<boolean> {
    if (hasActiveMembership) return true;
    const existing = await this.repos.customerMemberships.findByCustomerAndBusiness(customerId, businessId);
    return existing === undefined || existing.status === 'left';
  }
}
