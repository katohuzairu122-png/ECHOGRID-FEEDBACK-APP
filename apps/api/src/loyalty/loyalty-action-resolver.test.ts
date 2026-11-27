import { describe, expect, it } from 'vitest';
import { sign } from 'hono/jwt';
import { LoyaltyActionResolver } from './loyalty-action-resolver';
import { signCustomerQrToken } from '../qr/customer-qr-token';
import { signQrToken } from '../qr/qr-token';

const SECRET = 'resolver-test-secret';
const BUSINESS_ID = crypto.randomUUID();
const BRANCH_ID = crypto.randomUUID();
const CUSTOMER_ID = crypto.randomUUID();
const MEMBERSHIP_ID = crypto.randomUUID();
const ACCOUNT_ID = crypto.randomUUID();
const TIER_ID = crypto.randomUUID();
const OTHER_BRANCH_ID = crypto.randomUUID();
const future = new Date(Date.now() + 86_400_000);
const past = new Date(Date.now() - 86_400_000);
/** Cheapest first, as the repository returns them. */
const rewardRows = [
  { id: 'r-free-coffee', businessId: BUSINESS_ID, branchId: null, name: 'Free coffee', type: 'points', pointsCost: 100, startDate: null, expiryDate: null },
  { id: 'r-pastry', businessId: BUSINESS_ID, branchId: null, name: 'Pastry', type: 'points', pointsCost: 150, startDate: null, expiryDate: null },
  { id: 'r-other-branch', businessId: BUSINESS_ID, branchId: OTHER_BRANCH_ID, name: 'Other branch only', type: 'points', pointsCost: 50, startDate: null, expiryDate: null },
  { id: 'r-this-branch', businessId: BUSINESS_ID, branchId: BRANCH_ID, name: 'This branch only', type: 'points', pointsCost: 60, startDate: null, expiryDate: null },
  { id: 'r-expired', businessId: BUSINESS_ID, branchId: null, name: 'Expired', type: 'points', pointsCost: 10, startDate: null, expiryDate: past },
  { id: 'r-not-started', businessId: BUSINESS_ID, branchId: null, name: 'Not started', type: 'points', pointsCost: 10, startDate: future, expiryDate: null },
  { id: 'r-voucher', businessId: BUSINESS_ID, branchId: null, name: 'Voucher', type: 'voucher', pointsCost: null, startDate: null, expiryDate: null },
].sort((a, b) => (a.pointsCost ?? 0) - (b.pointsCost ?? 0));
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
  /** A membership the customer holds that is not active (left, suspended, ...). */
  otherMembershipStatus?: string,
) {
  const customer = { id: CUSTOMER_ID, status: 'active', qrRevocationEpoch: 0, fullName: 'Amina Yusuf Al-Rashid' };
  const membership = activeMembership
    ? {
        id: MEMBERSHIP_ID,
        customerId: CUSTOMER_ID,
        businessId: BUSINESS_ID,
        status: 'active',
      }
    : undefined;
  const otherMembership = otherMembershipStatus
    ? {
        id: MEMBERSHIP_ID,
        customerId: CUSTOMER_ID,
        businessId: BUSINESS_ID,
        status: otherMembershipStatus,
      }
    : undefined;
  const account = activeMembership
    ? {
        id: ACCOUNT_ID,
        customerId: CUSTOMER_ID,
        businessId: BUSINESS_ID,
        membershipId: MEMBERSHIP_ID,
        points: 120,
        tierId: TIER_ID,
        visitCount: 7,
        lastVisitAt: new Date('2026-11-20T10:00:00.000Z'),
        status: 'active',
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
      async findByCustomerAndBusiness(customerId: string, businessId: string) {
        return customerId === CUSTOMER_ID && businessId === BUSINESS_ID
          ? (membership ?? otherMembership)
          : undefined;
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
    loyaltyTiers: {
      async findById(id: string, businessId: string) {
        return id === TIER_ID && businessId === BUSINESS_ID ? { id: TIER_ID, businessId, name: 'Silver' } : undefined;
      },
    },
    loyaltyRewards: {
      async listForBusiness(businessId: string) {
        return businessId === BUSINESS_ID ? rewardRows : [];
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
  otherMembershipStatus?: string,
) {
  return new LoyaltyActionResolver(
    createRepos(
      activeMembership,
      campaigns,
      activeCommunityMembership,
      hasAvailableOrphan,
      receivingBusinessStatus,
      otherMembershipStatus,
    ) as unknown as ConstructorParameters<typeof LoyaltyActionResolver>[0],
    { QR_TOKEN_SECRET: SECRET, QR_TOKEN_SECRET_PREVIOUS: undefined },
  );
}

async function businessQrToken() {
  return signQrToken({ qrCodeId: QR_ID, businessId: BUSINESS_ID, branchId: BRANCH_ID }, SECRET);
}

describe('LoyaltyActionResolver', () => {
  it('rejects invalid, foreign-signed and expired customer identities before exposing actions', async () => {
    const expired = await sign(
      { sub: CUSTOMER_ID, type: 'qr_customer', iat: 1, exp: 2, nonce: 'expired', sigVer: 1 },
      SECRET,
      'HS256',
    );
    for (const token of [
      'invalid',
      await signCustomerQrToken(CUSTOMER_ID, 'other-secret'),
      expired,
    ]) {
      await expect(
        resolver(true).resolveCustomerForStaff({
          customerQrToken: token,
          businessId: BUSINESS_ID,
          permissions: new Set(['loyalty:serve']),
        }),
      ).rejects.toMatchObject({ status: 404, code: 'CUSTOMER_QR_NOT_FOUND' });
    }
  });

  it('rejects a customer QR issued under an older revocation epoch (CUSTOMER-QR-ROTATION-01)', async () => {
    const stale = await signCustomerQrToken(CUSTOMER_ID, SECRET, 1); // fixture customer is at epoch 0
    await expect(
      resolver(true).resolveCustomerForStaff({
        customerQrToken: stale,
        businessId: BUSINESS_ID,
        permissions: new Set(['loyalty:serve']),
      }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_QR_NOT_FOUND' });
  });

  it('accepts the current-epoch QR repeatedly: resolving never consumes it', async () => {
    const token = await signCustomerQrToken(CUSTOMER_ID, SECRET, 0);
    const r = resolver(true);
    for (let i = 0; i < 3; i += 1) {
      const result = await r.resolveCustomerForStaff({
        customerQrToken: token,
        businessId: BUSINESS_ID,
        permissions: new Set(['loyalty:serve']),
      });
      expect(result.customerId).toBe(CUSTOMER_ID);
    }
  });

  it('does not expose another business relationship or loyalty write actions', async () => {
    const result = await resolver(true).resolveCustomerForStaff({
      customerQrToken: await signCustomerQrToken(CUSTOMER_ID, SECRET),
      businessId: crypto.randomUUID(),
      permissions: new Set(['loyalty:serve']),
    });
    expect(result.loyaltyAccountId).toBeNull();
    expect(result.actions).toEqual([]);
  });

  it('legacy loyalty:view / loyalty:manage alone no longer authorize any loyalty action (D-C1, fails closed)', async () => {
    for (const permissions of [['loyalty:view'], ['loyalty:manage'], ['loyalty:view', 'loyalty:manage'], ['loyalty:accounts:view', 'loyalty:adjust']]) {
      const result = await resolver(true).resolveCustomerForStaff({
        customerQrToken: await signCustomerQrToken(CUSTOMER_ID, SECRET),
        businessId: BUSINESS_ID,
        permissions: new Set(permissions),
      });
      expect(result.actions, permissions.join('+')).toEqual([]);
    }
  });

  it('does not offer enrollment or check-in at an inactive receiving business', async () => {
    for (const member of [false, true]) {
      const result = await resolver(
        member,
        [],
        false,
        false,
        'suspended',
      ).resolveBusinessForCustomer({
        businessQrToken: await businessQrToken(),
        customerId: CUSTOMER_ID,
      });
      expect(result.actions).not.toContain('JOIN_LOYALTY');
      expect(result.actions).not.toContain('CHECK_IN');
    }
  });
  it('returns only permission-backed staff actions for this business relationship', async () => {
    const token = await signCustomerQrToken(CUSTOMER_ID, SECRET);
    const result = await resolver(true).resolveCustomerForStaff({
      customerQrToken: token,
      businessId: BUSINESS_ID,
      permissions: new Set(['loyalty:serve']),
    });

    expect(result.membershipStatus).toBe('active');
    expect(result.loyaltyAccountId).toBe(ACCOUNT_ID);
    expect(result.actions).toEqual([
      'VIEW_ALLOWED_MEMBERSHIP_STATE',
      'VALIDATE_PURCHASE',
      'GRANT_LOYALTY_PROGRESS',
      'REDEEM_REWARD',
    ]);
  });

  it('offers settlement-access request from staff capability without querying customer orphan ownership', async () => {
    const token = await signCustomerQrToken(CUSTOMER_ID, SECRET);
    const result = await resolver(false, [], false, false).resolveCustomerForStaff({
      customerQrToken: token,
      businessId: BUSINESS_ID,
      permissions: new Set(['loyalty:serve', 'settlement:view']),
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
      permissions: new Set(['loyalty:serve']),
    });

    expect(result.actions).not.toContain('REQUEST_ORPHAN_SETTLEMENT_ACCESS');
  });

  it('does not expose loyalty actions when this business has no relationship', async () => {
    const token = await signCustomerQrToken(CUSTOMER_ID, SECRET);
    const result = await resolver(false).resolveCustomerForStaff({
      customerQrToken: token,
      businessId: BUSINESS_ID,
      permissions: new Set(['loyalty:serve']),
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

  it('offers JOIN_LOYALTY to a customer who left, so they can come back', async () => {
    const result = await resolver(false, [], false, false, 'active', 'left').resolveBusinessForCustomer({
      businessQrToken: await businessQrToken(),
      customerId: CUSTOMER_ID,
    });
    expect(result.actions).toEqual(['JOIN_LOYALTY', 'LEAVE_FEEDBACK']);
    expect(result.membershipStatus).toBe('none');
  });

  it.each(['suspended', 'pending', 'business_exited', 'closed'])(
    'does not offer JOIN_LOYALTY for a %s membership: the customer cannot restart it, so the join would be refused',
    async (status) => {
      const result = await resolver(false, [], false, false, 'active', status).resolveBusinessForCustomer({
        businessQrToken: await businessQrToken(),
        customerId: CUSTOMER_ID,
      });
      expect(result.actions).toEqual(['LEAVE_FEEDBACK']);
      expect(result.loyaltyAccountId).toBeNull();
      expect(result.membershipStatus).toBe('none');
    },
  );

  it('still offers JOIN_LOYALTY to an active member whose loyalty account is missing: joining creates it', async () => {
    const repos = createRepos(true);
    repos.loyaltyAccounts.findByCustomerAndBusiness = async () => undefined;
    const result = await new LoyaltyActionResolver(
      repos as unknown as ConstructorParameters<typeof LoyaltyActionResolver>[0],
      { QR_TOKEN_SECRET: SECRET, QR_TOKEN_SECRET_PREVIOUS: undefined },
    ).resolveBusinessForCustomer({
      businessQrToken: await businessQrToken(),
      customerId: CUSTOMER_ID,
    });
    expect(result.actions).toEqual(['JOIN_LOYALTY', 'LEAVE_FEEDBACK']);
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
    const result = await resolver(false, [], false, true, 'suspended').resolveBusinessForCustomer({
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

  describe('cashier customer card (staff scan)', () => {
    const scan = async (permissions: string[], activeMembership = true, branchId: string | null = BRANCH_ID) =>
      resolver(activeMembership).resolveCustomerForStaff({
        customerQrToken: await signCustomerQrToken(CUSTOMER_ID, SECRET),
        businessId: BUSINESS_ID,
        permissions: new Set(permissions),
        ...(branchId ? { branchId } : {}),
      });

    it('shows a member their first name, balance, tier, visits and the rewards of this business', async () => {
      const { card } = await scan(['loyalty:serve']);
      expect(card).toMatchObject({
        displayName: 'Amina',
        points: 120,
        tier: { name: 'Silver' },
        visitCount: 7,
        lastVisitAt: '2026-11-20T10:00:00.000Z',
      });
      expect(card?.rewards.map((r) => [r.name, r.pointsCost, r.enoughPoints, r.pointsNeeded])).toEqual([
        ['This branch only', 60, true, 0],
        ['Free coffee', 100, true, 0],
        ['Pastry', 150, false, 30],
      ]);
    });

    it('lists only points rewards that are live, business-wide or for the scanning branch', async () => {
      const names = (await scan(['loyalty:serve'])).card?.rewards.map((r) => r.name) ?? [];
      expect(names).not.toContain('Expired');
      expect(names).not.toContain('Not started');
      expect(names).not.toContain('Voucher');
      expect(names).not.toContain('Other branch only');
      const noBranch = (await scan(['loyalty:serve'], true, null)).card?.rewards.map((r) => r.name) ?? [];
      expect(noBranch).not.toContain('This branch only');
    });

    it('never exposes identifiers, contact details or another business on the card', async () => {
      const { card } = await scan(['loyalty:serve']);
      expect(Object.keys(card ?? {}).sort()).toEqual(['displayName', 'lastVisitAt', 'points', 'rewards', 'tier', 'visitCount']);
      const text = JSON.stringify(card);
      expect(text).not.toContain(CUSTOMER_ID);
      expect(text).not.toContain('Al-Rashid');
    });

    it('returns no card for a non-member, or for staff who may not serve loyalty', async () => {
      expect((await scan(['loyalty:serve'], false)).card).toBeNull();
      expect((await scan(['settlement:view'])).card).toBeNull();
      expect((await scan([])).card).toBeNull();
    });

    it('returns no card at a different business even for the same customer', async () => {
      const result = await resolver(true).resolveCustomerForStaff({
        customerQrToken: await signCustomerQrToken(CUSTOMER_ID, SECRET),
        businessId: crypto.randomUUID(),
        permissions: new Set(['loyalty:serve']),
        branchId: BRANCH_ID,
      });
      expect(result.card).toBeNull();
    });
  });
});
