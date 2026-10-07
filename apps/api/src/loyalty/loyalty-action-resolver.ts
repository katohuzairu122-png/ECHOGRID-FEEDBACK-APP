import type { Bindings } from '../config/env';
import type { Repositories } from '../repositories';
import { AppError } from '../lib/errors';
import { QrCodeService } from '../qr/qr-code.service';
import { verifyCustomerQrToken } from '../qr/customer-qr-token';

export type LoyaltyResolvedAction =
  | 'JOIN_LOYALTY'
  | 'OPEN_LOYALTY_CARD'
  | 'VIEW_REWARDS'
  | 'CHECK_IN'
  | 'LEAVE_FEEDBACK'
  | 'VIEW_ALLOWED_MEMBERSHIP_STATE'
  | 'VALIDATE_PURCHASE'
  | 'GRANT_LOYALTY_PROGRESS'
  | 'REDEEM_REWARD';

export class LoyaltyActionResolver {
  constructor(
    private readonly repos: Pick<
      Repositories,
      'customers' | 'customerMemberships' | 'loyaltyAccounts' | 'qrCodes' | 'fraudSignals'
    >,
    private readonly secrets: Pick<Bindings, 'QR_TOKEN_SECRET' | 'QR_TOKEN_SECRET_PREVIOUS'>,
  ) {}

  async resolveCustomerForStaff(input: {
    customerQrToken: string;
    businessId: string;
    permissions: Set<string>;
  }): Promise<{
    customerId: string;
    loyaltyAccountId: string | null;
    membershipStatus: 'active' | 'none';
    actions: LoyaltyResolvedAction[];
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
    if (!customer || customer.status !== 'active') {
      throw new AppError('This customer QR code is no longer valid.', 404, 'CUSTOMER_QR_NOT_FOUND');
    }

    const membership = await this.repos.customerMemberships.findActive(customer.id, input.businessId);
    const account = membership
      ? await this.repos.loyaltyAccounts.findByCustomerAndBusiness(customer.id, input.businessId)
      : undefined;

    const actions: LoyaltyResolvedAction[] = [];
    if (membership && account) {
      if (input.permissions.has('loyalty:view')) actions.push('VIEW_ALLOWED_MEMBERSHIP_STATE');
      if (input.permissions.has('loyalty:manage')) {
        actions.push('VALIDATE_PURCHASE', 'GRANT_LOYALTY_PROGRESS');
      }
    }

    return {
      customerId: customer.id,
      loyaltyAccountId: account?.id ?? null,
      membershipStatus: membership ? 'active' : 'none',
      actions,
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
  }> {
    const qrCode = await new QrCodeService(this.repos, this.secrets).resolveToken(input.businessQrToken);
    const membership = await this.repos.customerMemberships.findActive(input.customerId, qrCode.businessId);
    const account = membership
      ? await this.repos.loyaltyAccounts.findByCustomerAndBusiness(input.customerId, qrCode.businessId)
      : undefined;

    const actions: LoyaltyResolvedAction[] = ['LEAVE_FEEDBACK'];
    if (!membership || !account) {
      actions.unshift('JOIN_LOYALTY');
    } else {
      actions.unshift('OPEN_LOYALTY_CARD', 'VIEW_REWARDS', 'CHECK_IN');
    }

    return {
      businessId: qrCode.businessId,
      branchId: qrCode.branchId,
      loyaltyAccountId: account?.id ?? null,
      membershipStatus: membership ? 'active' : 'none',
      actions,
    };
  }
}
