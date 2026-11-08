import { describe, expect, it } from 'vitest';
import { assertTenantAuthorizationContext } from './tenant-authorization-context';

const valid = () => ({
  userId: 'staff-a',
  businessId: 'business-a',
  businessWideAccess: true,
  permissions: new Set(['loyalty:view', 'branches:manage']),
});

function expectDenied(context: Parameters<typeof assertTenantAuthorizationContext>[0]) {
  expect(() => assertTenantAuthorizationContext(context)).toThrowError(
    expect.objectContaining({ status: 403, code: 'TENANT_CONTEXT_UNAVAILABLE' }),
  );
}

describe('Group 13 tenant authorization context integrity', () => {
  it('accepts business-wide context and valid branch-scoped context', () => {
    expect(() => assertTenantAuthorizationContext(valid())).not.toThrow();
    expect(() => assertTenantAuthorizationContext({
      ...valid(), branchId: 'branch-a', businessWideAccess: false,
    })).not.toThrow();
    expect(() => assertTenantAuthorizationContext({
      ...valid(), branchId: 'branch-a',
    })).not.toThrow();
    expect(() => assertTenantAuthorizationContext({
      ...valid(), permissions: new Set<string>(),
    })).not.toThrow();
  });

  it.each([
    '', ' ', ' user', 'user ', 'user/foreign', 'user,other',
    'u'.repeat(257), '\nuser', '_user',
  ])('DEV-83 rejects malformed staff identity %j', (userId) => {
    expectDenied({ ...valid(), userId });
  });

  it.each([
    '', ' ', ' business', 'business ', 'a/b',
    'a,b', 'b'.repeat(257), '_business',
  ])('DEV-83 rejects malformed business selector %j', (businessId) => {
    expectDenied({ ...valid(), businessId });
  });

  it.each([
    '', ' ', ' foreign', 'branch ', 'a/b',
    'a,b', 'b'.repeat(257), '_branch',
  ])('DEV-83 rejects malformed optional branch selector %j', (branchId) => {
    expectDenied({ ...valid(), branchId });
  });

  it('denies a missing branch for a branch-scoped grant', () => {
    expectDenied({ ...valid(), businessWideAccess: false });
  });

  it.each([
    null, '', ' ', ' loyalty:view', 'loyalty:view ',
    123, false, {}, 'p'.repeat(257),
  ])('DEV-84 rejects malformed permission entries without granting access (%j)', (entry) => {
    expectDenied({ ...valid(), permissions: new Set([entry]) });
  });

  it.each([
    null, undefined, [], ['loyalty:view'], 'loyalty:view', {},
  ])('DEV-84 rejects non-Set permission containers (%j)', (permissions) => {
    expectDenied({ ...valid(), permissions });
  });

  it('DEV-85 rejects absent or contradictory authorization metadata', () => {
    expectDenied({ ...valid(), userId: undefined });
    expectDenied({ ...valid(), businessId: undefined });
    expectDenied({ ...valid(), businessWideAccess: undefined });
    expectDenied({ ...valid(), businessWideAccess: 'true' });
    expectDenied({ ...valid(), businessWideAccess: false, branchId: null });
  });
});
