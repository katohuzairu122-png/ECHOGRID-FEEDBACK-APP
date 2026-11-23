import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import { CommunityMembershipRepository } from '../repositories/community-membership.repository';
import { COMMUNITY_MEMBERSHIP_CONTROL_KEYS, CommunityMembershipControls, assertCommunityMembershipWrite, recordCommunityMembershipControl, type CommunityMembershipWritePermit } from './community-membership-controls';

afterEach(() => vi.restoreAllMocks());
describe('CONTROL-01 independent fail-closed operation controls', () => {
  const db = {} as Db;
  for (const operation of ['join', 'rejoin', 'restore', 'clearance'] as const) {
    it.each([undefined, 'false', '', 'TRUE', ' true', 'true ', '1', true, 1, null, {}])(`${operation} rejects %j`, (value) => {
      const controls = new CommunityMembershipControls({ [COMMUNITY_MEMBERSHIP_CONTROL_KEYS[operation]]: value });
      expect(controls.available(operation)).toBe(false);
      expect(() => controls.authorize(db, 'synthetic', operation)).toThrow(expect.objectContaining({ status: 503, code: 'COMMUNITY_MEMBERSHIP_OPERATION_DISABLED' }));
    });
    it(`${operation} enables only itself and snapshots configuration`, () => {
      const config = { [COMMUNITY_MEMBERSHIP_CONTROL_KEYS[operation]]: 'true' };
      const controls = new CommunityMembershipControls(config);
      config[COMMUNITY_MEMBERSHIP_CONTROL_KEYS[operation]] = 'false';
      expect(controls.available(operation)).toBe(true);
      for (const other of ['join', 'rejoin', 'restore', 'clearance'] as const) if (other !== operation) expect(controls.available(other)).toBe(false);
      expect(new CommunityMembershipControls(config).available(operation)).toBe(false);
    });
  }
  it('repository permits cannot be forged, serialized, reused for another customer/transaction or used for clearance', () => {
    const controls = new CommunityMembershipControls({ COMMUNITY_MEMBERSHIP_JOIN_ENABLED: 'true', COMMUNITY_MEMBERSHIP_CLEARANCE_ENABLED: 'true' });
    const permit = controls.authorize(db, 'synthetic', 'join');
    expect(() => assertCommunityMembershipWrite(db, 'synthetic', 'active', permit)).not.toThrow();
    for (const candidate of [undefined, {} as CommunityMembershipWritePermit, JSON.parse(JSON.stringify(permit)) as CommunityMembershipWritePermit]) {
      expect(() => assertCommunityMembershipWrite(db, 'synthetic', 'active', candidate)).toThrow();
    }
    expect(() => assertCommunityMembershipWrite({} as Db, 'synthetic', 'active', permit)).toThrow();
    expect(() => assertCommunityMembershipWrite(db, 'bystander', 'active', permit)).toThrow();
    expect(() => assertCommunityMembershipWrite(db, 'synthetic', 'inactive', permit)).toThrow();
    const clearance = controls.authorize(db, 'synthetic', 'clearance');
    expect(() => assertCommunityMembershipWrite(db, 'synthetic', 'inactive', clearance)).not.toThrow();
    expect(() => assertCommunityMembershipWrite(db, 'synthetic', 'active', clearance)).toThrow();
    for (const state of ['left', 'suspended', undefined]) expect(() => assertCommunityMembershipWrite(db, 'synthetic', state)).not.toThrow();
  });
  it('direct repository activation, implicit active insert and clearance stop before SQL', async () => {
    const fake = { insert: vi.fn(), update: vi.fn() };
    const repo = new CommunityMembershipRepository(fake as unknown as Db);
    await expect(repo.create({ customerId: 'synthetic', policyVersion: 'synthetic' })).rejects.toMatchObject({ code: 'COMMUNITY_MEMBERSHIP_OPERATION_DISABLED' });
    await expect(repo.create({ customerId: 'synthetic', status: 'active', policyVersion: 'synthetic' })).rejects.toMatchObject({ status: 503 });
    for (const status of ['active', 'inactive'] as const) await expect(repo.updateStatus('synthetic', { status })).rejects.toMatchObject({ status: 503 });
    expect(fake.insert).not.toHaveBeenCalled(); expect(fake.update).not.toHaveBeenCalled();
  });
  it('telemetry is bounded, contains only controlled fields and cannot throw into an operation', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('SINK_FAILED'); });
    expect(() => recordCommunityMembershipControl('clearance', 'transition_failed')).not.toThrow();
    recordCommunityMembershipControl('clearance', 'transition_failed');
    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(log.mock.calls[0]![0]));
    expect(payload).toEqual({ event: 'community_membership.control', operation: 'clearance', reason: 'transition_failed' });
  });
});

it('a caller cannot mutate an active write into clearance while the repository awaits state', async () => {
  let release!: (row: { status: 'left' }) => void;
  const written: unknown[] = [];
  const fake = {
    query: { communityMemberships: { findFirst: () => new Promise(resolve => { release = resolve; }) } },
    update: () => ({ set: (value: unknown) => { written.push(value); return { where: () => ({ returning: async () => [{ status: 'active' }] }) }; } }),
  };
  const db = fake as unknown as Db;
  const permit = new CommunityMembershipControls({ COMMUNITY_MEMBERSHIP_REJOIN_ENABLED: 'true' }).authorize(db, 'synthetic', 'rejoin');
  const patch: { status: 'active' | 'inactive' } = { status: 'active' };
  const result = new CommunityMembershipRepository(db).updateStatus('synthetic', patch, permit);
  patch.status = 'inactive';
  release({ status: 'left' });
  await result;
  expect(written).toEqual([expect.objectContaining({ status: 'active' })]);
});
