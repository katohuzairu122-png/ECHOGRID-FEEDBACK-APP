import { describe, expect, it, vi } from 'vitest';
import {
  CustomerLookupService,
  LOOKUP_AUDIT_HIT,
  LOOKUP_AUDIT_MISS,
  LOOKUP_MISS_LIMIT,
  LOOKUP_PURCHASE_AUDIT,
  LOOKUP_PURCHASE_CAP_PER_BUSINESS,
  LOOKUP_PURCHASE_CAP_PER_STAFF,
  LOOKUP_PURCHASE_WINDOW_MS,
  maskPhone,
  phoneAuditHash,
} from './customer-lookup.service';
import { signCustomerLookupToken } from './customer-lookup-token';
import { signCustomerQrToken } from '../qr/customer-qr-token';
import { AppError } from '../lib/errors';

const SECRET = 'lookup-service-test-secret';
const BUSINESS = crypto.randomUUID();
const OTHER_BUSINESS = crypto.randomUUID();
const STAFF = crypto.randomUUID();
const OTHER_STAFF = crypto.randomUUID();
const CUSTOMER = crypto.randomUUID();
const ACCOUNT = crypto.randomUUID();
const PHONE = '+15551234567';
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

type Overrides = {
  customer?: Record<string, unknown> | null;
  membership?: unknown;
  account?: Record<string, unknown> | null;
  counts?: Record<string, number>;
};

function build(o: Overrides = {}) {
  const audit: Record<string, unknown>[] = [];
  const customer =
    o.customer === null
      ? undefined
      : { id: CUSTOMER, phone: PHONE, status: 'active', fullName: 'Amina Okafor', email: 'amina@example.com', ...o.customer };
  const account =
    o.account === null ? undefined : { id: ACCOUNT, customerId: CUSTOMER, status: 'active', points: 120, ...o.account };
  const repos = {
    customers: {
      findByPhone: vi.fn(async (phone: string) => (customer && phone === PHONE ? customer : undefined)),
      findById: vi.fn(async (id: string) => (customer && id === CUSTOMER ? customer : undefined)),
    },
    customerMemberships: {
      findActive: vi.fn(async (_c: string, b: string) =>
        o.membership === undefined ? (b === BUSINESS ? { id: 'm' } : undefined) : o.membership,
      ),
    },
    loyaltyAccounts: {
      findByCustomerAndBusiness: vi.fn(async (_c: string, b: string) => (b === BUSINESS ? account : undefined)),
    },
    auditLog: {
      record: vi.fn(async (entry: Record<string, unknown>) => {
        audit.push(entry);
      }),
      countSince: vi.fn(async (q: { action: string; actorUserId?: string }) => {
        const key = `${q.action}:${q.actorUserId ? 'staff' : 'business'}`;
        return o.counts?.[key] ?? 0;
      }),
    },
  };
  const service = new CustomerLookupService(
    repos as never,
    { QR_TOKEN_SECRET: SECRET, QR_TOKEN_SECRET_PREVIOUS: undefined } as never,
    () => NOW,
  );
  return { service, repos, audit };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('expected a failure');
}

describe('maskPhone and phoneAuditHash', () => {
  it('shows only the last four digits', () => {
    expect(maskPhone('+15551234567')).toBe('+•••••••4567');
    expect(maskPhone('+15551234567')).not.toContain('555');
  });
  it('is a stable keyed hash that differs per phone and per secret', async () => {
    const a = await phoneAuditHash(PHONE, SECRET);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await phoneAuditHash(PHONE, SECRET)).toBe(a);
    expect(await phoneAuditHash('+15557654321', SECRET)).not.toBe(a);
    expect(await phoneAuditHash(PHONE, 'another-secret')).not.toBe(a);
  });
});

describe('CustomerLookupService.lookup', () => {
  const args = { phone: PHONE, businessId: BUSINESS, staffUserId: STAFF };

  it('returns the minimum: first name, masked phone, actions and a token, with no ids or contact data', async () => {
    const { service } = build();
    const result = await service.lookup(args);
    expect(result).toMatchObject({
      displayName: 'Amina',
      phoneMasked: '+•••••••4567',
      membershipStatus: 'active',
      actions: ['VIEW_ALLOWED_MEMBERSHIP_STATE', 'VALIDATE_PURCHASE', 'GRANT_LOYALTY_PROGRESS'],
    });
    const json = JSON.stringify(result);
    for (const secret of [CUSTOMER, ACCOUNT, PHONE, 'amina@example.com', 'Okafor']) {
      expect(json).not.toContain(secret);
    }
    expect(Object.keys(result).sort()).toEqual(
      ['actions', 'displayName', 'lookupToken', 'membershipStatus', 'phoneMasked'].sort(),
    );
  });

  it('falls back to "Member" when no name is stored', async () => {
    const { service } = build({ customer: { fullName: null } });
    expect((await service.lookup(args)).displayName).toBe('Member');
  });

  it('limits a suspended account to viewing membership state', async () => {
    const { service } = build({ account: { status: 'suspended' } });
    expect((await service.lookup(args)).actions).toEqual(['VIEW_ALLOWED_MEMBERSHIP_STATE']);
  });

  it('audits a hit and a miss with a keyed hash of the phone, never the number', async () => {
    const hit = build();
    await hit.service.lookup(args);
    const miss = build({ customer: null });
    await failure(miss.service.lookup(args));
    for (const { audit, action } of [
      { audit: hit.audit, action: LOOKUP_AUDIT_HIT },
      { audit: miss.audit, action: LOOKUP_AUDIT_MISS },
    ]) {
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ businessId: BUSINESS, actorUserId: STAFF, action });
      expect(JSON.stringify(audit[0])).not.toContain(PHONE);
      expect((audit[0]!.metadata as { phoneHash: string }).phoneHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('gives an identical response for an unknown number, a non-member, a suspended customer and a member without an account', async () => {
    const cases = [
      build({ customer: null }), // unknown number
      build({ membership: null }), // customer exists but is not a member of this business
      build({ customer: { status: 'suspended' } }),
      build({ account: null }), // membership row but no loyalty account
    ];
    const errors = await Promise.all(cases.map((c) => failure(c.service.lookup(args))));
    for (const err of errors) {
      expect(err).toBeInstanceOf(AppError);
      expect(err.status).toBe(404);
      expect(err.code).toBe('MEMBER_NOT_FOUND');
      expect(err.message).toBe(errors[0]!.message);
    }
  });

  it('treats a member of a different business as a miss', async () => {
    const { service } = build();
    const err = await failure(service.lookup({ ...args, businessId: OTHER_BUSINESS }));
    expect(err.code).toBe('MEMBER_NOT_FOUND');
  });

  it('throttles after too many misses and does not touch the customer table while throttled', async () => {
    const { service, repos } = build({ counts: { [`${LOOKUP_AUDIT_MISS}:staff`]: LOOKUP_MISS_LIMIT } });
    const err = await failure(service.lookup(args));
    expect(err.status).toBe(429);
    expect(err.code).toBe('LOOKUP_THROTTLED');
    expect(repos.customers.findByPhone).not.toHaveBeenCalled();
  });

  it('counts misses for this cashier in this business over the last ten minutes', async () => {
    const { service, repos } = build();
    await service.lookup(args);
    const call = repos.auditLog.countSince.mock.calls[0]![0] as {
      action: string;
      since: Date;
      businessId: string;
      actorUserId: string;
    };
    expect(call).toMatchObject({ action: LOOKUP_AUDIT_MISS, businessId: BUSINESS, actorUserId: STAFF });
    expect(NOW - call.since.getTime()).toBe(10 * 60 * 1000);
  });
});

describe('CustomerLookupService.resolvePurchaseTarget', () => {
  async function token(overrides: { businessId?: string; staffUserId?: string; customerId?: string } = {}) {
    return signCustomerLookupToken(
      {
        customerId: overrides.customerId ?? CUSTOMER,
        businessId: overrides.businessId ?? BUSINESS,
        staffUserId: overrides.staffUserId ?? STAFF,
      },
      SECRET,
    );
  }
  const base = { businessId: BUSINESS, staffUserId: STAFF };

  it('returns the account for a valid token bound to this business and cashier', async () => {
    const { service } = build();
    await expect(service.resolvePurchaseTarget({ ...base, lookupToken: await token() })).resolves.toEqual({
      accountId: ACCOUNT,
    });
  });

  it.each([
    ['another business', { businessId: OTHER_BUSINESS }],
    ['another cashier', { staffUserId: OTHER_STAFF }],
  ])('rejects a token issued for %s with the same expired response', async (_label, mismatch) => {
    const { service } = build();
    const err = await failure(
      service.resolvePurchaseTarget({ ...base, lookupToken: await token(mismatch) }),
    );
    expect(err.status).toBe(404);
    expect(err.code).toBe('LOOKUP_EXPIRED');
  });

  it('rejects garbage, a customer QR token and a token for a customer that is gone', async () => {
    const { service } = build({ customer: null });
    for (const lookupToken of ['not-a-token', await signCustomerQrToken(CUSTOMER, SECRET), await token()]) {
      const err = await failure(service.resolvePurchaseTarget({ ...base, lookupToken }));
      expect(err.code).toBe('LOOKUP_EXPIRED');
    }
  });

  it('rejects when the account has been suspended since the lookup', async () => {
    const { service } = build({ account: { status: 'suspended' } });
    const err = await failure(service.resolvePurchaseTarget({ ...base, lookupToken: await token() }));
    expect(err.code).toBe('LOOKUP_EXPIRED');
  });

  it('refuses once the per-cashier or per-business daily cap is reached', async () => {
    for (const counts of [
      { [`${LOOKUP_PURCHASE_AUDIT}:staff`]: LOOKUP_PURCHASE_CAP_PER_STAFF },
      { [`${LOOKUP_PURCHASE_AUDIT}:business`]: LOOKUP_PURCHASE_CAP_PER_BUSINESS },
    ]) {
      const { service } = build({ counts });
      const err = await failure(service.resolvePurchaseTarget({ ...base, lookupToken: await token() }));
      expect(err.status).toBe(429);
      expect(err.code).toBe('LOOKUP_PURCHASE_CAP_REACHED');
    }
  });

  it('counts lookup purchases over a rolling 24 hours', async () => {
    const { service, repos } = build();
    await service.resolvePurchaseTarget({ ...base, lookupToken: await token() });
    const sinces = repos.auditLog.countSince.mock.calls.map((c) => (c[0] as unknown as { since: Date }).since.getTime());
    expect(sinces).toHaveLength(2);
    for (const since of sinces) expect(NOW - since).toBe(LOOKUP_PURCHASE_WINDOW_MS);
  });
});
