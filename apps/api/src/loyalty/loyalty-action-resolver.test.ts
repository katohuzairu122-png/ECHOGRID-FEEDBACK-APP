import { describe, expect, it } from 'vitest';
import { LoyaltyActionResolver } from './loyalty-action-resolver';
import { signCustomerQrToken } from '../qr/customer-qr-token';
import { signQrToken } from '../qr/qr-token';

const SECRET = 'resolver-test-secret';
const BUSINESS_ID = crypto.randomUUID();
const BRANCH_ID = crypto.randomUUID();
const CUSTOMER_ID = crypto.randomUUID();
const MEMBERSHIP_ID = crypto.randomUUID();
const ACCOUNT_ID = crypto.randomUUID();
const QR_ID = crypto.randomUUID();

type Audience =
  | 'customer'
  | 'community_candidate'
  | 'community_member'
  | 'business_member'
  | 'general_authenticated_participant';

function campaign(audienceClass: Audience, name: string = audienceClass) {
  return {
    id: crypto.randomUUID(),
    surveyId: crypto.randomUUID(),
    surveyVersionId: crypto.randomUUID(),
    businessId: BUSINESS_ID,
    branchId: null,
    name,
    status: 'active',
    audienceClass,
    repeatPolicy: 'once_per_campaign',
    exposeInQrResolver: true,
    startsAt: null,
    endsAt: null,
    maxResponses: null,
  };
}

function createRepos(
  activeMembership: boolean,
  campaigns = [] as ReturnType<typeof campaign>[],
  activeCommunityMembership = false,
  hasAvailableOrphan = false,
  receivingBusinessStatus: 'active' | 'suspended' | 'archived' = 'active',
) {
  const customer = { id: CUSTOMER_ID, status: 'active' };
  const membership = activeMembership
    ? {
        id: MEMBERSHIP_ID,
        customerId: CUSTOMER_ID,
        businessId: BUSINESS_ID,
        status: 'active',
      }
    : undefined;
  const account = activeMembership
    ? {
        id: ACCOUNT_ID,
        customerId: CUSTOMER_ID,
        businessId: BUSINESS_ID,
        membershipId: MEMBERSHIP_ID,
      }
    : undefined;
  const qrCode = {
    id: QR_ID,
    businessId: BUSINESS_ID,
    branchId: BRANCH_ID,
    type: 'business',
    status: 'active',
    isDeleted: false,
  };

  return {
    customers: {
      async findById(id: string) {
        return id === CUSTOMER_ID ? customer : undefined;
      },
    },
    customerMemberships: {
      async findActive(customerId: string, businessId: string) {
        return customerId === CUSTOMER_ID && businessId === BUSINESS_ID ? membership : undefined;
      },
    },
    communityMemberships: {
      async findActiveByCustomerId(customerId: string) {
        return customerId === CUSTOMER_ID && activeCommunityMembership
          ? {
              id: crypto.randomUUID(),
              customerId: CUSTOMER_ID,
              status: 'active',
              policyVersion: 'community-policy-v1',
            }
          : undefined;
      },
    },
    loyaltyAccounts: {
      async findByCustomerAndBusiness(customerId: string, businessId: string) {
        return customerId === CUSTOMER_ID && businessId === BUSINESS_ID ? account : undefined;
      },
    },
    qrCodes: {
      async findActiveById(id: string) {
        return id === QR_ID ? qrCode : undefined;
      },
    },
    fraudSignals: {
      async create() {
        return undefined;
      },
    },
    surveys: {
      async listQrExposedForBusinessBranch(businessId: string, branchId: string) {
        return businessId === BUSINESS_ID && branchId === BRANCH_ID ? campaigns : [];
      },
    },
    businesses: {
      async findById(id: string) {
        return id === BUSINESS_ID
          ? { id: BUSINESS_ID, status: receivingBusinessStatus, isDeleted: false }
          : undefined;
      },
    },
    orphanRewardClaims: {
      async existsAvailableForCustomerExcludingBusiness(
        customerId: string,
        excludedOriginBusinessId: string,
      ) {
        return (
          customerId === CUSTOMER_ID &&
          excludedOriginBusinessId === BUSINESS_ID &&
          hasAvailableOrphan
        );
      },
    },
  };
}

function resolver(
  activeMembership: boolean,
  campaigns = [] as ReturnType<typeof campaign>[],
  activeCommunityMembership = false,
  hasAvailableOrphan = false,
  receivingBusinessStatus: 'active' | 'suspended' | 'archived' = 'active',
) {
  return new LoyaltyActionResolver(
    createRepos(
      activeMembership,
      campaigns,
      activeCommunityMembership,
      hasAvailableOrphan,
      receivingBusinessStatus,
    ) as unknown as ConstructorParameters<typeof LoyaltyActionResolver>[0],
    { QR_TOKEN_SECRET: SECRET, QR_TOKEN_SECRET_PREVIOUS: undefined },
  );
}

async function businessQrToken() {
  return signQrToken(
    { qrCodeId: QR_ID, businessId: BUSINESS_ID, branchId: BRANCH_ID },
    SECRET,
  );
}

describe('LoyaltyActionResolver', () => {
  it('returns only permission-backed staff actions for this business relationship', async () => {
    const token = await signCustomerQrToken(CUSTOMER_ID, SECRET);
    const result = await resolver(true).resolveCustomerForStaff({
      customerQrToken: token,
      businessId: BUSINESS_ID,
      permissions: new Set(['loyalty:view', 'loyalty:manage']),
    });

    expect(result.membershipStatus).toBe('active');
    expect(result.loyaltyAccountId).toBe(ACCOUNT_ID);
    expect(result.actions).toEqual([
      'VIEW_ALLOWED_MEMBERSHIP_STATE',
      'VALIDATE_PURCHASE',
      'GRANT_LOYALTY_PROGRESS',
    ]);
  });

  it('offers settlement-access request from staff capability without querying customer orphan ownership', async () => {
    const token = await signCustomerQrToken(CUSTOMER_ID, SECRET);
    const result = await resolver(false, [], false, false).resolveCustomerForStaff({
      customerQrToken: token,
      businessId: BUSINESS_ID,
      permissions: new Set(['loyalty:view', 'settlement:view']),
    });

    expect(result.membershipStatus).toBe('none');
    expect(result.loyaltyAccountId).toBeNull();
    expect(result.actions).toEqual(['REQUEST_ORPHAN_SETTLEMENT_ACCESS']);
  });

  it('does not expose settlement-access request when staff lacks settlement:view', async () => {
    const token = await signCustomerQrToken(CUSTOMER_ID, SECRET);
    const result = await resolver(false, [], false, true).resolveCustomerForStaff({
      customerQrToken: token,
      businessId: BUSINESS_ID,
      permissions: new Set(['loyalty:view']),
    });

    expect(result.actions).not.toContain('REQUEST_ORPHAN_SETTLEMENT_ACCESS');
  });

  it('does not expose loyalty actions when this business has no relationship', async () => {
    const token = await signCustomerQrToken(CUSTOMER_ID, SECRET);
    const result = await resolver(false).resolveCustomerForStaff({
      customerQrToken: token,
      businessId: BUSINESS_ID,
      permissions: new Set(['loyalty:view', 'loyalty:manage']),
    });
    expect(result.membershipStatus).toBe('none');
    expect(result.loyaltyAccountId).toBeNull();
    expect(result.actions).toEqual([]);
  });

  it('returns JOIN_LOYALTY and no survey action when no eligible campaign exists', async () => {
    const result = await resolver(false).resolveBusinessForCustomer({
      businessQrToken: await businessQrToken(),
      customerId: CUSTOMER_ID,
    });
    expect(result.actions).toEqual(['JOIN_LOYALTY', 'LEAVE_FEEDBACK']);
    expect(result.surveyCampaigns).toEqual([]);
  });

  it('exposes SETTLE_ORPHAN_REWARD only when an available claim exists for another origin business', async () => {
    const none = await resolver(false, [], false, false).resolveBusinessForCustomer({
      businessQrToken: await businessQrToken(),
      customerId: CUSTOMER_ID,
    });
    expect(none.actions).not.toContain('SETTLE_ORPHAN_REWARD');

    const eligible = await resolver(false, [], false, true).resolveBusinessForCustomer({
      businessQrToken: await businessQrToken(),
      customerId: CUSTOMER_ID,
    });
    expect(eligible.actions).toContain('SETTLE_ORPHAN_REWARD');
    expect(eligible).not.toHaveProperty('claimId');
    expect(eligible).not.toHaveProperty('settlementId');
    expect(eligible).not.toHaveProperty('rewardValue');
  });

  it('does not expose SETTLE_ORPHAN_REWARD for an inactive receiving business', async () => {
    const result = await resolver(
      false,
      [],
      false,
      true,
      'suspended',
    ).resolveBusinessForCustomer({
      businessQrToken: await businessQrToken(),
      customerId: CUSTOMER_ID,
    });

    expect(result.actions).not.toContain('SETTLE_ORPHAN_REWARD');
  });

  it('exposes a general authenticated survey to a non-member without granting authority in the QR', async () => {
    const general = campaign('general_authenticated_participant', 'Experience survey');
    const result = await resolver(false, [general]).resolveBusinessForCustomer({
      businessQrToken: await businessQrToken(),
      customerId: CUSTOMER_ID,
    });

    expect(result.actions).toEqual(['JOIN_LOYALTY', 'LEAVE_FEEDBACK', 'TAKE_SURVEY']);
    expect(result.surveyCampaigns).toEqual([
      {
        campaignId: general.id,
        surveyId: general.surveyId,
        surveyVersionId: general.surveyVersionId,
        name: 'Experience survey',
        audienceClass: 'general_authenticated_participant',
      },
    ]);
  });

  it('hides business-member surveys from non-members and exposes them after membership exists', async () => {
    const memberOnly = campaign('business_member', 'Members survey');

    const nonMember = await resolver(false, [memberOnly]).resolveBusinessForCustomer({
      businessQrToken: await businessQrToken(),
      customerId: CUSTOMER_ID,
    });
    expect(nonMember.actions).toEqual(['JOIN_LOYALTY', 'LEAVE_FEEDBACK']);
    expect(nonMember.surveyCampaigns).toEqual([]);

    const member = await resolver(true, [memberOnly]).resolveBusinessForCustomer({
      businessQrToken: await businessQrToken(),
      customerId: CUSTOMER_ID,
    });
    expect(member.actions).toEqual([
      'OPEN_LOYALTY_CARD',
      'VIEW_REWARDS',
      'CHECK_IN',
      'LEAVE_FEEDBACK',
      'TAKE_SURVEY',
    ]);
    expect(member.surveyCampaigns).toHaveLength(1);
  });

  it('exposes community_member surveys only to active Community members', async () => {
    const community = campaign('community_member', 'Community survey');

    const nonMember = await resolver(true, [community], false).resolveBusinessForCustomer({
      businessQrToken: await businessQrToken(),
      customerId: CUSTOMER_ID,
    });
    expect(nonMember.actions).not.toContain('TAKE_SURVEY');
    expect(nonMember.surveyCampaigns).toEqual([]);

    const member = await resolver(true, [community], true).resolveBusinessForCustomer({
      businessQrToken: await businessQrToken(),
      customerId: CUSTOMER_ID,
    });
    expect(member.actions).toContain('TAKE_SURVEY');
    expect(member.surveyCampaigns).toHaveLength(1);
    expect(member.surveyCampaigns[0]!.audienceClass).toBe('community_member');
  });

  it('exposes community_candidate surveys only when no active Community membership exists', async () => {
    const candidate = campaign('community_candidate', 'Community candidate survey');

    const nonMember = await resolver(false, [candidate], false).resolveBusinessForCustomer({
      businessQrToken: await businessQrToken(),
      customerId: CUSTOMER_ID,
    });
    expect(nonMember.actions).toContain('TAKE_SURVEY');
    expect(nonMember.surveyCampaigns).toHaveLength(1);
    expect(nonMember.surveyCampaigns[0]!.audienceClass).toBe('community_candidate');

    const activeMember = await resolver(false, [candidate], true).resolveBusinessForCustomer({
      businessQrToken: await businessQrToken(),
      customerId: CUSTOMER_ID,
    });
    expect(activeMember.actions).not.toContain('TAKE_SURVEY');
    expect(activeMember.surveyCampaigns).toEqual([]);
  });
});
