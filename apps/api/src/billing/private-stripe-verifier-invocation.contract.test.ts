import { describe, expect, it } from 'vitest';
import { authorizePrivateInvocation, canonicalPrivateInvocation,
  MAX_INVOCATION_LIFETIME_MS, type InvocationRequest,
  type InvocationPolicy, type InvocationDependencies } from './private-stripe-verifier-invocation.contract';

const NOW = 1_783_000_000_000; // synthetic Unix epoch ms
const invoiceScope = {
  invoiceId: 'in_SYNTHETIC123', businessId: 'business-synthetic',
  customerId: 'cus_SYNTHETIC123', subscriptionId: 'sub_SYNTHETIC123',
} as const;
const request: InvocationRequest = {
  audience: 'worker:synthetic-account:synthetic-uuid',
  operation: 'GET /v1/account', inventoryRevision: 'synthetic-r1',
  nonce: 'synthetic_nonce_123456789012345',
  issuedAt: NOW - 1000, expiresAt: NOW + 20_000,
};
const policy: InvocationPolicy = {
  approved: true, revoked: false, callerPrincipal: 'synthetic-test-runner',
  audience: request.audience, credentialVersion: 'synthetic-cred-v1',
  inventoryRevision: request.inventoryRevision,
  methods: ['GET /v1/account', 'GET /v1/invoices/{id}'],
  invoiceScope, expiresAt: NOW + 40_000,
};
type Proof = { signedRequest: string };
const makeProof = (r: InvocationRequest): Proof =>
  ({ signedRequest: canonicalPrivateInvocation(r) });
const makeDeps = (): InvocationDependencies<Proof> => {
  const used = new Set<string>(); // synthetic only; NOT atomic durable implementation
  return {
    authenticate: async (proof, canonicalRequest) =>
      proof.signedRequest === canonicalRequest
        ? { principal: 'synthetic-test-runner', audience: request.audience,
          credentialVersion: 'synthetic-cred-v1', authenticatedRequest: canonicalRequest }
        : null,
    claimOnce: async (key) => !used.has(key) && Boolean(used.add(key)),
  };
};
const check = (r: InvocationRequest = request, p: InvocationPolicy | null = policy,
  d = makeDeps(), time = NOW, proof = makeProof(request)) =>
  authorizePrivateInvocation(r, proof, p, d, time);

describe('S08 verifier private invocation remediation (synthetic offline only)', () => {
  it('allows one exact approved account read and blocks replay', async () => {
    const deps = makeDeps();
    expect((await check(request, policy, deps)).allowed).toBe(true);
    expect(await check(request, policy, deps))
      .toEqual({ allowed: false, reason: 'REPLAY_REJECTED' });
  });

  it.each([
    ['audience', { audience: 'worker:other:uuid' }],
    ['operation', { operation: 'GET /v1/invoices/{id}', invoiceScope }],
    ['revision', { inventoryRevision: 'synthetic-r2' }],
    ['nonce', { nonce: 'synthetic_nonce_123456789012346' }],
    ['issuedAt', { issuedAt: NOW - 2000 }],
    ['expiresAt', { expiresAt: NOW + 10_000 }],
  ] as const)('request-bound proof rejects tampered %s', async (_name, change) => {
    const changed = { ...request, ...change } as InvocationRequest;
    const result = await check(changed);
    expect(result.allowed).toBe(false);
  });

  it('rejects tampered invoice scope even with same caller proof', async () => {
    const r = { ...request, operation: 'GET /v1/invoices/{id}' as const, invoiceScope };
    const proof = makeProof(r);
    expect((await check(r, policy, makeDeps(), NOW, proof)).allowed).toBe(true);
    const altered = { ...r, invoiceScope: { ...invoiceScope, customerId: 'cus_OTHER' } };
    expect((await check(altered, policy, makeDeps(), NOW, proof)).allowed).toBe(false);
  });

  it('denies unapproved exact invoice/tenant scope even with correctly bound proof', async () => {
    const r = { ...request, operation: 'GET /v1/invoices/{id}' as const, invoiceScope };
    const different = { ...r, invoiceScope: { ...invoiceScope, invoiceId: 'in_OTHER' } };
    expect(await check(different, policy, makeDeps(), NOW, makeProof(different)))
      .toEqual({ allowed: false, reason: 'SCOPE_MISMATCH' });
    // a policy that carries no invoice scope at all (the key is omitted, not set to undefined, under exactOptionalPropertyTypes)
    const { invoiceScope: _omitted, ...policyWithoutScope } = policy;
    expect(await check(r, policyWithoutScope, makeDeps(), NOW, makeProof(r)))
      .toEqual({ allowed: false, reason: 'SCOPE_MISMATCH' });
  });

  it.each([
    ['expired', { expiresAt: NOW }, 'INVALID_REQUEST'],
    ['future issue beyond skew', { issuedAt: NOW + 31_000, expiresAt: NOW + 40_000 }, 'INVALID_REQUEST'],
    ['longer than 5 minutes', { issuedAt: NOW - 1, expiresAt: NOW + MAX_INVOCATION_LIFETIME_MS }, 'INVALID_REQUEST'],
    ['short nonce', { nonce: 'short' }, 'INVALID_REQUEST'],
    ['invoice missing scope', { operation: 'GET /v1/invoices/{id}' }, 'INVALID_REQUEST'],
    ['account read with invoice scope', { invoiceScope }, 'INVALID_REQUEST'],
  ] as const)('rejects %s', async (_name, change, reason) => {
    const r = { ...request, ...change } as InvocationRequest;
    expect(await check(r, policy, makeDeps(), NOW, makeProof(r)))
      .toEqual({ allowed: false, reason });
  });

  it('enforces expiry against approval and records replay TTL in seconds', async () => {
    const r = { ...request, expiresAt: NOW + 60_000 };
    expect(await check(r, policy, makeDeps(), NOW, makeProof(r)))
      .toEqual({ allowed: false, reason: 'SCOPE_MISMATCH' });
    let ttl = 0;
    const deps: InvocationDependencies<Proof> = {
      ...makeDeps(), claimOnce: async (_key, seconds) => { ttl = seconds; return true; },
    };
    expect((await check(request, policy, deps)).allowed).toBe(true);
    expect(ttl).toBe(20);
  });

  it.each([
    ['missing approval', { approved: false }],
    ['revoked', { revoked: true }],
    ['expired approval', { expiresAt: NOW }],
  ] as const)('denies %s', async (_name, change) => {
    expect(await check(request, { ...policy, ...change }))
      .toEqual({ allowed: false, reason: 'APPROVAL_EXPIRED' });
  });

  it('rejects trusted caller identity change and unbound proof', async () => {
    expect(await check(request, { ...policy, callerPrincipal: 'unknown' }))
      .toEqual({ allowed: false, reason: 'CALLER_NOT_APPROVED' });
    expect(await check(request, policy, makeDeps(), NOW, { signedRequest: 'other' }))
      .toEqual({ allowed: false, reason: 'AUTHENTICATION_FAILED' });
  });

  it('fails closed when authenticator or atomic claim adapter is unavailable', async () => {
    expect(await check(request, policy, {
      ...makeDeps(), authenticate: async () => { throw new Error('unavailable'); },
    })).toEqual({ allowed: false, reason: 'DEPENDENCY_UNAVAILABLE' });
    expect(await check(request, policy, {
      ...makeDeps(), claimOnce: async () => { throw new Error('unavailable'); },
    })).toEqual({ allowed: false, reason: 'DEPENDENCY_UNAVAILABLE' });
    expect(await check(request, policy, {
      ...makeDeps(), claimOnce: async () => false,
    })).toEqual({ allowed: false, reason: 'REPLAY_REJECTED' });
  });

  it('passes a collision-safe nonce key to the durable-store interface', async () => {
    let key = '';
    await check(request, policy, {
      ...makeDeps(), claimOnce: async (k) => { key = k; return true; },
    });
    expect(JSON.parse(key)).toEqual([
      's08', policy.callerPrincipal, request.audience, request.inventoryRevision, request.nonce,
    ]);
  });

  it('does not confer Stripe execution or settlement authority', async () => {
    const result = await check();
    expect(result).not.toHaveProperty('invoiceVerified');
    expect(result).not.toHaveProperty('financialAuthority');
  });
});
