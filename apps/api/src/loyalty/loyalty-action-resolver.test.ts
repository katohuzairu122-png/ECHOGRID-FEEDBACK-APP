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

function createRepos(activeMembership: boolean) {
  const customer = {
    id: CUSTOMER_ID,
    status: 'active',
  };
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
  };
}

function resolver(activeMembership: boolean) {
  return new LoyaltyActionResolver(
    createRepos(activeMembership) as unknown as ConstructorParameters<typeof LoyaltyActionResolver>[0],
    { QR_TOKEN_SECRET: SECRET, QR_TOKEN_SECRET_PREVIOUS: undefined },
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

  it('returns JOIN_LOYALTY when a customer scans a business QR without membership', async () => {
    const token = await signQrToken(
      { qrCodeId: QR_ID, businessId: BUSINESS_ID, branchId: BRANCH_ID },
      SECRET,
    );
    const result = await resolver(false).resolveBusinessForCustomer({
      businessQrToken: token,
      customerId: CUSTOMER_ID,
    });
    expect(result.actions).toEqual(['JOIN_LOYALTY', 'LEAVE_FEEDBACK']);
  });

  it('returns loyalty-card actions for an existing member scanning the business QR', async () => {
    const token = await signQrToken(
      { qrCodeId: QR_ID, businessId: BUSINESS_ID, branchId: BRANCH_ID },
      SECRET,
    );
    const result = await resolver(true).resolveBusinessForCustomer({
      businessQrToken: token,
      customerId: CUSTOMER_ID,
    });
    expect(result.actions).toEqual([
      'OPEN_LOYALTY_CARD',
      'VIEW_REWARDS',
      'CHECK_IN',
      'LEAVE_FEEDBACK',
    ]);
  });
});
