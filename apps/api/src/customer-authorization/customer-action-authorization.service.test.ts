import { describe, expect, it } from 'vitest';
import type { CustomerActionAuthorization, NewCustomerActionAuthorization } from '../repositories';
import {
  CustomerActionAuthorizationService,
  MAX_ACTION_AUTHORIZATION_TTL_SECONDS,
} from './customer-action-authorization.service';

const CUSTOMER_A = '9a7d1e3c-5b2f-4c68-8a10-2e4d6f8a0b12';
const CUSTOMER_B = '2b4d6f80-1a3c-4e5f-9a7b-0c1d2e3f4a5b';
const BUSINESS = '0b3f7f0e-6a55-4d1a-9d52-3f9e0a1f2c11';
const OTHER_BUSINESS = '3c5e7a90-2b4d-4f61-8a73-9b1d3f5a7c24';
const RESOURCE = '6d8f0b12-4c6e-4a80-9b92-1d3f5a7c9e35';

/**
 * An in-memory stand-in for the repository that behaves like the real one where
 * it matters here: the idempotency key is unique across ALL customers, and a
 * conflicting insert resolves to the row that already holds the key.
 */
function fakeRepository() {
  const rows: CustomerActionAuthorization[] = [];
  const repository = {
    async create(input: NewCustomerActionAuthorization): Promise<CustomerActionAuthorization> {
      if (input.idempotencyKey) {
        const existing = rows.find((row) => row.idempotencyKey === input.idempotencyKey);
        if (existing) return existing;
      }
      const row: CustomerActionAuthorization = {
        id: crypto.randomUUID(),
        issuedAt: new Date(),
        consumedAt: null,
        revokedAt: null,
        status: 'active',
        resourceType: null,
        resourceId: null,
        scope: null,
        idempotencyKey: null,
        metadata: null,
        ...input,
      } as CustomerActionAuthorization;
      rows.push(row);
      return row;
    },
    async consume(
      id: string,
      customerId: string,
    ): Promise<CustomerActionAuthorization | undefined> {
      const row = rows.find(
        (candidate) => candidate.id === id && candidate.customerId === customerId,
      );
      if (!row || row.status !== 'active' || row.expiresAt <= new Date()) return undefined;
      row.status = 'consumed';
      row.consumedAt = new Date();
      return row;
    },
  };
  return { rows, repository };
}

const setup = () => {
  const { rows, repository } = fakeRepository();
  const service = new CustomerActionAuthorizationService({
    customerActionAuthorizations: repository,
  } as never);
  return { rows, service };
};

type IssueInput = Parameters<CustomerActionAuthorizationService['issue']>[0];
type OptionalKey = 'resourceType' | 'resourceId' | 'scope' | 'idempotencyKey';

const BASE_REQUEST: IssueInput = {
  customerId: CUSTOMER_A,
  businessId: BUSINESS,
  actionType: 'redeem_reward',
  correlationId: 'corr-1',
  ttlSeconds: 300,
  resourceType: 'loyalty_reward',
  resourceId: RESOURCE,
  scope: 'redeem:one',
  idempotencyKey: 'retry-key-0001',
};

const request = (overrides: Partial<IssueInput> = {}): IssueInput => ({
  ...BASE_REQUEST,
  ...overrides,
});

/** The base request with the named optional fields left out entirely (not set to undefined). */
const requestWithout = (...omit: OptionalKey[]): IssueInput => {
  const input = request();
  for (const key of omit) delete input[key];
  return input;
};

describe('CustomerActionAuthorizationService.issue', () => {
  it('issues an active authorization that expires after the requested time', async () => {
    const { service } = setup();
    const before = Date.now();

    const authorization = await service.issue(request());

    expect(authorization).toMatchObject({
      customerId: CUSTOMER_A,
      businessId: BUSINESS,
      actionType: 'redeem_reward',
      resourceType: 'loyalty_reward',
      resourceId: RESOURCE,
      scope: 'redeem:one',
      status: 'active',
    });
    const lifetimeMs = authorization.expiresAt.getTime() - before;
    expect(lifetimeMs).toBeGreaterThanOrEqual(300_000);
    expect(lifetimeMs).toBeLessThan(301_000);
  });

  it.each([
    [0],
    [-5],
    [MAX_ACTION_AUTHORIZATION_TTL_SECONDS + 1],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [0.0001],
  ])('refuses a lifetime of %s seconds and stores nothing', async (ttlSeconds) => {
    const { rows, service } = setup();

    await expect(service.issue(request({ ttlSeconds }))).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_AUTHORIZATION_TTL',
    });
    expect(rows).toHaveLength(0);
  });

  it('allows exactly the maximum lifetime', async () => {
    const { service } = setup();
    await expect(
      service.issue(request({ ttlSeconds: MAX_ACTION_AUTHORIZATION_TTL_SECONDS })),
    ).resolves.toMatchObject({ status: 'active' });
  });

  it('issues a separate authorization each time when no idempotency key is given', async () => {
    const { rows, service } = setup();

    const first = await service.issue(requestWithout('idempotencyKey'));
    const second = await service.issue(requestWithout('idempotencyKey'));

    expect(first.id).not.toBe(second.id);
    expect(rows).toHaveLength(2);
    expect(first.idempotencyKey).toBeNull();
  });

  describe('idempotency', () => {
    it('answers a retry with the authorization it already issued, creating nothing new', async () => {
      const { rows, service } = setup();

      const first = await service.issue(request());
      const retry = await service.issue(request());

      expect(retry.id).toBe(first.id);
      expect(rows).toHaveLength(1);
    });

    it('treats a retry that spells the ids in another case as the same request', async () => {
      const { rows, service } = setup();

      const first = await service.issue(request());
      const retry = await service.issue(
        request({ businessId: BUSINESS.toUpperCase(), resourceId: RESOURCE.toUpperCase() }),
      );

      expect(retry.id).toBe(first.id);
      expect(rows).toHaveLength(1);
    });

    it('stores the key behind the customer id, so two customers can use the same key', async () => {
      const { rows, service } = setup();

      const forA = await service.issue(request({ customerId: CUSTOMER_A }));
      const forB = await service.issue(request({ customerId: CUSTOMER_B }));

      expect(forB.id).not.toBe(forA.id);
      expect(forB.customerId).toBe(CUSTOMER_B);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(2);
      expect(forA.idempotencyKey).toBe(`${CUSTOMER_A}:retry-key-0001`);
    });

    it('never hands one customer another customer’s authorization, even on a guessed key', async () => {
      const { service } = setup();
      const victim = await service.issue(request({ customerId: CUSTOMER_A }));

      const attacker = await service.issue(
        request({ customerId: CUSTOMER_B, idempotencyKey: 'retry-key-0001' }),
      );

      expect(attacker.id).not.toBe(victim.id);
      expect(attacker.customerId).toBe(CUSTOMER_B);
    });

    it.each<[string, () => IssueInput]>([
      ['another business', () => request({ businessId: OTHER_BUSINESS })],
      ['another action', () => request({ actionType: 'share_contact_details' })],
      ['another resource', () => request({ resourceId: '7e9a1c23-5d7f-4b91-8ca4-2e4a6c8e0f46' })],
      ['another resource type', () => request({ resourceType: 'loyalty_tier' })],
      ['another scope', () => request({ scope: 'redeem:two' })],
      ['no resource at all', () => requestWithout('resourceType', 'resourceId', 'scope')],
    ])('refuses a retry that reuses the key for %s', async (_label, retry) => {
      const { rows, service } = setup();
      await service.issue(request());

      await expect(service.issue(retry())).rejects.toMatchObject({
        status: 409,
        code: 'ACTION_AUTHORIZATION_IDEMPOTENCY_CONFLICT',
      });
      expect(rows).toHaveLength(1);
    });

    it.each([
      ['consumed', { status: 'consumed' as const }],
      ['revoked', { status: 'revoked' as const }],
      ['expired by status', { status: 'expired' as const }],
      ['past its expiry', { expiresAt: new Date(Date.now() - 1_000) }],
    ])(
      'does not hand back an authorization that is %s: the client must ask again with a new key',
      async (_label, change) => {
        const { rows, service } = setup();
        await service.issue(request());
        Object.assign(rows[0] as CustomerActionAuthorization, change);

        await expect(service.issue(request())).rejects.toMatchObject({
          status: 409,
          code: 'ACTION_AUTHORIZATION_IDEMPOTENCY_CONFLICT',
        });
      },
    );
  });
});

describe('CustomerActionAuthorizationService.consume', () => {
  it('consumes an active authorization once', async () => {
    const { service } = setup();
    const authorization = await service.issue(request());

    await expect(service.consume(authorization.id, CUSTOMER_A)).resolves.toMatchObject({
      status: 'consumed',
    });
    await expect(service.consume(authorization.id, CUSTOMER_A)).rejects.toMatchObject({
      status: 409,
      code: 'ACTION_AUTHORIZATION_INVALID',
    });
  });

  it('refuses another customer’s authorization', async () => {
    const { service } = setup();
    const authorization = await service.issue(request());

    await expect(service.consume(authorization.id, CUSTOMER_B)).rejects.toMatchObject({
      status: 409,
      code: 'ACTION_AUTHORIZATION_INVALID',
    });
  });
});
