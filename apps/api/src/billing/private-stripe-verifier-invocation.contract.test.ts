import { describe, expect, it } from 'vitest';
import { authorizePrivateInvocation, type InvocationRequest, type InvocationPolicy,
  type InvocationDependencies } from './private-stripe-verifier-invocation.contract';

const request: InvocationRequest = {
  audience: 'worker:synthetic-account:synthetic-uuid',
  operation: 'GET /v1/account', inventoryRevision: 'synthetic-r1',
  nonce: 'synthetic_nonce_123456789012345', issuedAt: 1000, expiresAt: 2000,
};
const policy: InvocationPolicy = {
  approved: true, revoked: false, callerPrincipal: 'synthetic-test-runner',
  audience: request.audience, credentialVersion: 'synthetic-cred-v1',
  inventoryRevision: request.inventoryRevision, methods: ['GET /v1/account'],
  expiresAt: 3000,
};
const proof = { data: 'synthetic-proof' };
const makeDeps = (): InvocationDependencies<typeof proof> => {
  const used = new Set<string>();
  return {
    authenticate: async () => ({ principal: 'synthetic-test-runner',
      audience: request.audience, credentialVersion: 'synthetic-cred-v1' }),
    claimOnce: async (key) => !used.has(key) && Boolean(used.add(key)),
  };
};
const check = (r: InvocationRequest = request, p: InvocationPolicy | null = policy,
  d = makeDeps(), time = 1500) => authorizePrivateInvocation(r, proof, p, d, time);

describe('S08 private invocation contract — offline synthetic cases', () => {
  it('permits an exact authenticated, approved, one-use request', async () => {
    expect(await check()).toEqual({ allowed: true, principal: policy.callerPrincipal,
      inventoryRevision: policy.inventoryRevision, operation: request.operation });
  });
  it('atomically rejects a duplicate nonce (synthetic store)', async () => {
    const deps = makeDeps();
    expect((await check(request, policy, deps)).allowed).toBe(true);
    expect(await check(request, policy, deps)).toEqual({ allowed: false, reason: 'REPLAY_REJECTED' });
  });
  it.each([
    ['wrong audience', { audience: 'worker:other:uuid' }, 'TARGET_MISMATCH'],
    ['wrong revision', { inventoryRevision: 'synthetic-r2' }, 'SCOPE_MISMATCH'],
    ['expired request', { expiresAt: 1500 }, 'INVALID_REQUEST'],
    ['too-long request lifetime', { expiresAt: 999999 }, 'INVALID_REQUEST'],
    ['short nonce', { nonce: 'short' }, 'INVALID_REQUEST'],
    ['invoice id absent', { operation: 'GET /v1/invoices/{id}' }, 'INVALID_REQUEST'],
    ['unsanctioned invoice', { operation: 'GET /v1/invoices/{id}', invoiceId: 'in_SYNTHETIC123' }, 'SCOPE_MISMATCH'],
    ['account request with invoice', { invoiceId: 'in_SYNTHETIC123' }, 'INVALID_REQUEST'],
  ] as const)('%s fails closed', async (_name, change, reason) => {
    expect(await check({ ...request, ...change } as InvocationRequest))
      .toEqual({ allowed: false, reason });
  });
  it.each([
    ['not approved', { approved: false }, 'APPROVAL_EXPIRED'],
    ['revoked', { revoked: true }, 'APPROVAL_EXPIRED'],
    ['expired', { expiresAt: 1500 }, 'APPROVAL_EXPIRED'],
    ['caller changed', { callerPrincipal: 'unknown' }, 'CALLER_NOT_APPROVED'],
    ['version changed', { credentialVersion: 'other' }, 'CALLER_NOT_APPROVED'],
  ] as const)('%s fails closed', async (_name, change, reason) => {
    expect(await check(request, { ...policy, ...change })).toEqual({ allowed: false, reason });
  });
  it('denies unauthenticated identity and dependency failure', async () => {
    expect(await check(request, policy, { ...makeDeps(), authenticate: async () => null }))
      .toEqual({ allowed: false, reason: 'AUTHENTICATION_FAILED' });
    expect(await check(request, policy, { ...makeDeps(), authenticate: async () => { throw new Error('down'); } }))
      .toEqual({ allowed: false, reason: 'DEPENDENCY_UNAVAILABLE' });
    expect(await check(request, policy, { ...makeDeps(), claimOnce: async () => { throw new Error('down'); } }))
      .toEqual({ allowed: false, reason: 'DEPENDENCY_UNAVAILABLE' });
    expect(await check(request, policy, { ...makeDeps(), claimOnce: async () => false }))
      .toEqual({ allowed: false, reason: 'REPLAY_REJECTED' });
  });
  it('does not authenticate caller-supplied metadata without trusted adapter', async () => {
    expect(await check(request, policy, { ...makeDeps(), authenticate: async () => null }))
      .not.toHaveProperty('allowed', true);
  });
});
