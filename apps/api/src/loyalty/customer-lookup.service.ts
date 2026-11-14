import type { LoyaltyResolvedActionDto, LookupCustomerResultDto } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import type { Repositories } from '../repositories';
import { AppError } from '../lib/errors';
import {
  signCustomerLookupToken,
  verifyCustomerLookupToken,
} from './customer-lookup-token';

/**
 * Cashier customer lookup by phone number (D-C2, docs/architecture/builds/CASHIER/DC2_CUSTOMER_LOOKUP_DESIGN.md).
 *
 * A lookup finds an ACTIVE member of the caller's own business by exact phone number and returns the minimum a
 * cashier needs: first name, masked phone, and the actions allowed. It never returns a customer id, loyalty
 * account id, email, birthday or full number, and it never creates a customer, membership or account. Every
 * miss (unknown number, not a member here, suspended customer or account) looks identical to the caller.
 *
 * Because a lookup identifies a customer WITHOUT the customer presenting anything, it is controlled by:
 *   - a short-lived signed token bound to business, staff user and customer (the only handle the cashier gets);
 *   - an audit row for every lookup, holding an HMAC of the phone and never the number itself;
 *   - a miss throttle (repeated misses lock lookups out for a few minutes);
 *   - daily caps on purchases recorded through a lookup, per cashier and per business;
 *   - no reward redemption through a lookup (redemption needs the customer's own code).
 * Limits are counted from audit_log, so no schema change is needed. The numbers below are starting estimates
 * for the owner to tune (decision D-C2-4).
 */
export const LOOKUP_MISS_LIMIT = 8;
export const LOOKUP_MISS_WINDOW_MS = 10 * 60 * 1000;
export const LOOKUP_PURCHASE_CAP_PER_STAFF = 40;
export const LOOKUP_PURCHASE_CAP_PER_BUSINESS = 200;
export const LOOKUP_PURCHASE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const LOOKUP_AUDIT_HIT = 'loyalty.customer_lookup';
export const LOOKUP_AUDIT_MISS = 'loyalty.customer_lookup_miss';
export const LOOKUP_PURCHASE_AUDIT = 'loyalty.purchase_recorded_via_lookup';

const NOT_FOUND_MESSAGE = 'No member found with this phone number.';
const EXPIRED_MESSAGE = 'This lookup has expired. Look the customer up again.';

type Secrets = Pick<Bindings, 'QR_TOKEN_SECRET' | 'QR_TOKEN_SECRET_PREVIOUS'>;
type LookupRepos = Pick<
  Repositories,
  'customers' | 'customerMemberships' | 'loyaltyAccounts' | 'auditLog'
>;

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: string | ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const raw = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

/** Keyed hash of a phone number for the audit trail. Domain-separated from every other use of the secret. */
export async function phoneAuditHash(phone: string, secret: string): Promise<string> {
  const derived = await hmac(secret, 'customer-lookup-audit-v1');
  return toHex(await hmac(derived, phone));
}

/** "+15551234567" becomes "+•••••••4567": the last four digits only. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/^\+/, '');
  return `+${'•'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

export class CustomerLookupService {
  constructor(
    private readonly repos: LookupRepos,
    private readonly secrets: Secrets,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async lookup(input: {
    phone: string;
    businessId: string;
    staffUserId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    /** Set when the request came from a cashier-scoped token (CASHIER-PWA-01 C7): marks the audit rows as cashier activity. */
    cashier?: { branchId: string | null } | undefined;
  }): Promise<LookupCustomerResultDto> {
    const since = new Date(this.clock() - LOOKUP_MISS_WINDOW_MS);
    const misses = await this.repos.auditLog.countSince({
      action: LOOKUP_AUDIT_MISS,
      since,
      businessId: input.businessId,
      actorUserId: input.staffUserId,
    });
    if (misses >= LOOKUP_MISS_LIMIT) {
      throw new AppError(
        'Too many lookups found no member. Wait a few minutes, or scan the customer’s QR code.',
        429,
        'LOOKUP_THROTTLED',
      );
    }

    const phoneHash = await phoneAuditHash(input.phone, this.secrets.QR_TOKEN_SECRET);
    const cashierMark = input.cashier ? { client: 'cashier', branchId: input.cashier.branchId } : {};
    const customer = await this.repos.customers.findByPhone(input.phone);
    const membership =
      customer && customer.status === 'active'
        ? await this.repos.customerMemberships.findActive(customer.id, input.businessId)
        : undefined;
    const account =
      customer && membership
        ? await this.repos.loyaltyAccounts.findByCustomerAndBusiness(customer.id, input.businessId)
        : undefined;

    if (!customer || !membership || !account) {
      await this.repos.auditLog.record({
        businessId: input.businessId,
        actorUserId: input.staffUserId,
        action: LOOKUP_AUDIT_MISS,
        entityType: 'customer_lookup',
        entityId: null,
        metadata: { phoneHash, ...cashierMark },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      });
      throw new AppError(NOT_FOUND_MESSAGE, 404, 'MEMBER_NOT_FOUND');
    }

    await this.repos.auditLog.record({
      businessId: input.businessId,
      actorUserId: input.staffUserId,
      action: LOOKUP_AUDIT_HIT,
      entityType: 'customer_lookup',
      entityId: customer.id,
      metadata: { phoneHash, ...cashierMark },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });

    const actions: LoyaltyResolvedActionDto[] = ['VIEW_ALLOWED_MEMBERSHIP_STATE'];
    if (account.status !== 'suspended') actions.push('VALIDATE_PURCHASE', 'GRANT_LOYALTY_PROGRESS');

    const firstName = customer.fullName?.trim().split(/\s+/)[0];
    return {
      lookupToken: await signCustomerLookupToken(
        {
          customerId: customer.id,
          businessId: input.businessId,
          staffUserId: input.staffUserId,
        },
        this.secrets.QR_TOKEN_SECRET,
      ),
      displayName: firstName ? firstName : 'Member',
      phoneMasked: maskPhone(input.phone),
      membershipStatus: 'active',
      actions,
    };
  }

  /**
   * Re-verifies a lookup token at purchase time and returns the loyalty account to credit. Everything is checked
   * again (token, binding, customer, membership, account, caps), because a token alone never grants a purchase.
   */
  async resolvePurchaseTarget(input: {
    lookupToken: string;
    businessId: string;
    staffUserId: string;
  }): Promise<{ accountId: string }> {
    let payload;
    try {
      payload = await verifyCustomerLookupToken(
        input.lookupToken,
        this.secrets.QR_TOKEN_SECRET,
        this.secrets.QR_TOKEN_SECRET_PREVIOUS,
      );
    } catch {
      throw new AppError(EXPIRED_MESSAGE, 404, 'LOOKUP_EXPIRED');
    }
    if (payload.bid !== input.businessId || payload.uid !== input.staffUserId) {
      throw new AppError(EXPIRED_MESSAGE, 404, 'LOOKUP_EXPIRED');
    }

    const customer = await this.repos.customers.findById(payload.sub);
    const membership =
      customer && customer.status === 'active'
        ? await this.repos.customerMemberships.findActive(customer.id, input.businessId)
        : undefined;
    const account =
      customer && membership
        ? await this.repos.loyaltyAccounts.findByCustomerAndBusiness(customer.id, input.businessId)
        : undefined;
    if (!customer || !membership || !account || account.status === 'suspended') {
      throw new AppError(EXPIRED_MESSAGE, 404, 'LOOKUP_EXPIRED');
    }

    const since = new Date(this.clock() - LOOKUP_PURCHASE_WINDOW_MS);
    const [byStaff, byBusiness] = await Promise.all([
      this.repos.auditLog.countSince({
        action: LOOKUP_PURCHASE_AUDIT,
        since,
        businessId: input.businessId,
        actorUserId: input.staffUserId,
      }),
      this.repos.auditLog.countSince({
        action: LOOKUP_PURCHASE_AUDIT,
        since,
        businessId: input.businessId,
      }),
    ]);
    if (byStaff >= LOOKUP_PURCHASE_CAP_PER_STAFF || byBusiness >= LOOKUP_PURCHASE_CAP_PER_BUSINESS) {
      throw new AppError(
        'The limit for purchases entered by phone lookup has been reached. Scan the customer’s QR code instead.',
        429,
        'LOOKUP_PURCHASE_CAP_REACHED',
      );
    }
    return { accountId: account.id };
  }
}
