import { describe, expect, it, vi } from 'vitest';
import {
  B4_BRANCH_READ_SQL,
  readOneBranchViaBroker,
  type B4RestrictedQuery,
  type B4SignedBranchAssertion,
} from './branch-broker-read.contract';

const actor = 'b7000000-0000-4000-8000-000000000001';
const session = 'b7000000-0000-4000-8000-000000000002';
const businessA = 'a7000000-0000-4000-8000-000000000001';
const businessB = 'a7000000-0000-4000-8000-000000000002';
const branchA = 'c7000000-0000-4000-8000-000000000001';
const branchB = 'c7000000-0000-4000-8000-000000000002';
const nonce = 'd7000000-0000-4000-8000-000000000001';
const request = 'd7000000-0000-4000-8000-000000000002';

const proof = (): B4SignedBranchAssertion => ({
  kid: 'fixture-key', issuer: 'fixture-issuer', audience: 'fixture-broker',
  actorId: actor, sessionId: session, businessId: businessA, branchId: branchA,
  operation: 'branches:read', nonce, requestId: request, issuedAt: 100,
  expiresAt: 160, signature: 'a'.repeat(64),
});
const row = () => ({
  branch_id: branchA, business_id: businessA, branch_name: 'Branch A',
  branch_slug: 'branch-a', branch_status: 'active',
});
function db(rows: unknown[] = [row()]) {
  const query = vi.fn(async (_text: string, _values: readonly (string | number)[]) => ({
    rows: rows as Awaited<ReturnType<B4RestrictedQuery['query']>>['rows'],
  }));
  return { query };
}

describe('Gate 2 B4 restricted branch read contract (NOT a deployed authorization)', () => {
  it('calls exactly one schema-qualified broker function with parameter placeholders', async () => {
    const q = db();
    await expect(readOneBranchViaBroker(q, proof())).resolves.toEqual({
      id: branchA, businessId: businessA, name: 'Branch A', slug: 'branch-a', status: 'active',
    });
    expect(q.query).toHaveBeenCalledTimes(1);
    expect(q.query.mock.calls[0]?.[0]).toBe(B4_BRANCH_READ_SQL);
    expect(q.query.mock.calls[0]?.[1]).toHaveLength(13);
    expect(B4_BRANCH_READ_SQL).not.toMatch(/FROM\s+(?:public\.)?branches\b/i);
    expect(B4_BRANCH_READ_SQL).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE/i);
  });

  it('returns null only when broker explicitly returns zero rows', async () => {
    await expect(readOneBranchViaBroker(db([]), proof())).resolves.toBeNull();
  });

  it('rejects cross-tenant or cross-branch rows returned by a compromised broker', async () => {
    await expect(readOneBranchViaBroker(db([{ ...row(), business_id: businessB }]), proof()))
      .rejects.toThrow('B4_BROKER_RESPONSE_REJECTED');
    await expect(readOneBranchViaBroker(db([{ ...row(), branch_id: branchB }]), proof()))
      .rejects.toThrow('B4_BROKER_RESPONSE_REJECTED');
  });

  it('rejects multiple rows and malformed response fields', async () => {
    await expect(readOneBranchViaBroker(db([row(), row()]), proof()))
      .rejects.toThrow('B4_BROKER_RESPONSE_REJECTED');
    await expect(readOneBranchViaBroker(db([{ ...row(), branch_status: 'unknown' }]), proof()))
      .rejects.toThrow('B4_BROKER_RESPONSE_REJECTED');
  });

  it('rejects absent, malformed, unsigned and wrong-operation assertions before issuing SQL', async () => {
    const bad: unknown[] = [
      undefined, { ...proof(), signature: '' }, { ...proof(), signature: 'a'.repeat(63) },
      { ...proof(), businessId: 'invalid' }, { ...proof(), sessionId: '' },
      { ...proof(), operation: 'settlement:write' }, { ...proof(), expiresAt: 500 },
      { ...proof(), issuedAt: Number.NaN }, { ...proof(), nonce: '' },
    ];
    for (const candidate of bad) {
      const q = db();
      await expect(readOneBranchViaBroker(q, candidate as B4SignedBranchAssertion))
        .rejects.toThrow('B4_ASSERTION_REJECTED');
      expect(q.query).not.toHaveBeenCalled();
    }
  });

  it('propagates database signature, membership or revocation refusal without a direct-SQL fallback', async () => {
    const q: B4RestrictedQuery = { query: vi.fn(async () => {
      throw Object.assign(new Error('broker denied'), { code: '42501' });
    }) };
    await expect(readOneBranchViaBroker(q, proof())).rejects.toThrow('broker denied');
    expect(q.query).toHaveBeenCalledTimes(1);
  });
});
