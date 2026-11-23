import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CommunityMembershipService } from '../../src/community/community-membership.service';
import { CommunityPlatformStateService } from '../../src/community/community-platform-state.service';
import { CommunityMembershipControls, COMMUNITY_MEMBERSHIP_CONTROL_KEYS, type CommunityMembershipControlConfig } from '../../src/community/community-membership-controls';
import { ConsentWithdrawalService } from '../../src/consent/consent-withdrawal.service';
import { publishSyntheticCommunityTerms, syntheticCommunityAcceptance, SYNTHETIC_MEMBERSHIP_CONTROLS } from '../helpers/community-consent-fixtures';

const url = process.env.DATABASE_URL;
if (url && !['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Disposable loopback PostgreSQL required');
describe.skipIf(!url)('CONTROL-01 real PostgreSQL containment', () => {
  const client = new Client({ connectionString: url });
  const db = buildDb(client);
  const enabled = new CommunityMembershipService(db, SYNTHETIC_MEMBERSHIP_CONTROLS);
  const platform = new CommunityPlatformStateService(db, SYNTHETIC_MEMBERSHIP_CONTROLS);
  const extra: Client[] = [];
  let actor: string;
  const q = async (sql: string, args: unknown[] = []) => (await client.query(sql, args)).rows;
  const audit = () => ({ actorUserId: actor, ipAddress: null, userAgent: null });
  const customer = async () => (await createRepositories(db).customers.create({ phone: '+1556' + Math.floor(Math.random() * 9e8), phoneVerifiedAt: new Date() })).id;
  const raw = (id: string) => syntheticCommunityAcceptance(enabled, id, 'control01-synthetic');
  const snapshot = async (id: string) => {
    const state: unknown[] = [];
    for (const table of ['community_memberships', 'community_point_accounts', 'consent_grants', 'community_point_transactions']) state.push(await q(`select * from ${table} where customer_id=$1 order by id`, [id]));
    state.push(await q("select * from audit_log where entity_type='community_membership' and metadata->>'customerId'=$1 order by id", [id]));
    for (const table of ['loyalty_accounts', 'loyalty_transactions', 'business_customer_memberships']) state.push(await q(`select * from ${table} order by id`));
    return state;
  };
  async function prepare(operation: 'join' | 'rejoin' | 'restore') {
    const id = await customer();
    if (operation !== 'join') {
      await enabled.join(id, await raw(id));
      await q('update community_point_accounts set points_balance=73 where customer_id=$1', [id]);
      if (operation === 'rejoin') await enabled.leave(id);
      else { await platform.suspend(id, { reason: 'Synthetic investigation.' }, audit()); await platform.restore(id, { reason: 'Synthetic clearance.' }, audit()); }
    }
    return { id, input: await raw(id) };
  }
  beforeAll(async () => {
    await client.connect();
    actor = (await q("insert into users(email,password_hash,full_name,status,platform_role) values($1,'unused','CONTROL-01 synthetic','active','admin') returning id", ['control01-' + crypto.randomUUID() + '@example.test']))[0].id;
  });
  beforeEach(async () => { await publishSyntheticCommunityTerms('control01-synthetic'); });
  afterAll(async () => { for (const c of extra) await c.end(); await client.end(); });

  for (const operation of ['join', 'rejoin', 'restore'] as const) {
    it.each([undefined, 'false', 'TRUE', '', true, ' true'])(`disabled ${operation} (%j) preserves complete state and consent; reads remain available`, async (value) => {
      const { id, input } = await prepare(operation);
      const config = { ...SYNTHETIC_MEMBERSHIP_CONTROLS, [COMMUNITY_MEMBERSHIP_CONTROL_KEYS[operation]]: value };
      const closed = new CommunityMembershipService(db, config);
      const before = await snapshot(id);
      expect((await closed.getOffer(id, 'en'))?.activationAvailable).toBe(false);
      await closed.getStatus(id);
      await expect(closed.join(id, input)).rejects.toMatchObject({ status: 503, code: 'COMMUNITY_MEMBERSHIP_OPERATION_DISABLED' });
      await expect(closed.join(id, { ...input, COMMUNITY_MEMBERSHIP_ACTIVATION_ENABLED: 'true' })).rejects.toMatchObject({ status: 503 });
      expect(await snapshot(id)).toEqual(before);
    });
    it(`enabled ${operation} needs only its own gate, preserves account identity and requires real consent`, async () => {
      const { id, input } = await prepare(operation);
      const service = new CommunityMembershipService(db, { [COMMUNITY_MEMBERSHIP_CONTROL_KEYS[operation]]: 'true' });
      const before = await service.getStatus(id);
      await expect(service.join(id, { ...input, consentAccepted: false })).rejects.toMatchObject({ code: 'COMMUNITY_CONSENT_REQUIRED' });
      const accepted = await service.join(id, input);
      expect(accepted.membership.status).toBe('active');
      expect(accepted.account.pointsBalance).toBe(operation === 'join' ? 0 : 73);
      if (before.membership) expect(accepted.membership.id).toBe(before.membership.id);
      if (before.account) expect(accepted.account.id).toBe(before.account.id);
      const duplicate = await service.join(id, input);
      expect(duplicate.consent).toEqual(accepted.consent);
      const closed = new CommunityMembershipService(db);
      const after = await snapshot(id);
      await expect(closed.join(id, input)).rejects.toMatchObject({ status: 503 });
      expect(await snapshot(id)).toEqual(after);
    });
    it(`six concurrent denied ${operation} requests cannot write evidence or balances`, async () => {
      const { id, input } = await prepare(operation);
      const before = await snapshot(id);
      const clients = await Promise.all(Array.from({ length: 6 }, async () => { const c = new Client({ connectionString: url }); await c.connect(); extra.push(c); return c; }));
      const results = await Promise.allSettled(clients.map(c => new CommunityMembershipService(buildDb(c)).join(id, input)));
      for (const result of results) { expect(result.status).toBe('rejected'); if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'COMMUNITY_MEMBERSHIP_OPERATION_DISABLED' }); }
      expect(await snapshot(id)).toEqual(before);
    });
  }

  it.each([undefined, 'false', 'TRUE', true])('clearance %j is independent and creates no inactive transition or revoked projection', async value => {
    const id = await customer(); await enabled.join(id, await raw(id)); await platform.suspend(id, { reason: 'Synthetic investigation.' }, audit());
    const before = await snapshot(id);
    await expect(new CommunityPlatformStateService(db, { ...SYNTHETIC_MEMBERSHIP_CONTROLS, COMMUNITY_MEMBERSHIP_CLEARANCE_ENABLED: value }).restore(id, { reason: 'Synthetic clearance.' }, audit())).rejects.toMatchObject({ status: 503 });
    expect(await snapshot(id)).toEqual(before);
    const cleared = await new CommunityPlatformStateService(db, { COMMUNITY_MEMBERSHIP_CLEARANCE_ENABLED: 'true' }).restore(id, { reason: 'Synthetic clearance.' }, audit());
    expect(cleared.membership.status).toBe('inactive'); expect(cleared.account.status).toBe('closed');
    const after = await snapshot(id);
    await expect(new CommunityMembershipService(db).join(id, await raw(id))).rejects.toMatchObject({ status: 503 });
    expect(await snapshot(id)).toEqual(after);
  });

  it('repository calls cannot activate or clear without a valid transaction/customer-specific permit', async () => {
    const id = await customer(); const repos = createRepositories(db); const before = await snapshot(id);
    await expect(repos.communityMemberships.create({ customerId: id, policyVersion: 'synthetic' })).rejects.toMatchObject({ status: 503 });
    expect(await snapshot(id)).toEqual(before);
    await enabled.join(id, await raw(id)); await enabled.leave(id); const left = await snapshot(id);
    await expect(repos.communityMemberships.updateStatus(id, { status: 'active' })).rejects.toMatchObject({ status: 503 });
    await expect(repos.communityMemberships.updateStatus(id, { status: 'inactive' })).rejects.toMatchObject({ status: 503 });
    const permit = new CommunityMembershipControls(SYNTHETIC_MEMBERSHIP_CONTROLS).authorize(db, id, 'join');
    await db.transaction(async tx => { await expect(createRepositories(tx).communityMemberships.updateStatus(id, { status: 'active' }, permit)).rejects.toMatchObject({ status: 503 }); });
    expect(await snapshot(id)).toEqual(left);
  });

  it('Leave, suspension and owned withdrawal still work with every gate absent', async () => {
    const id = await customer(); await enabled.join(id, await raw(id));
    const closed = new CommunityMembershipService(db);
    expect((await closed.leave(id)).membership?.status).toBe('left');
    await enabled.join(id, await raw(id));
    const grant = (await q("select id from consent_grants where customer_id=$1 and status='active' and purpose='community_membership'", [id]))[0].id;
    expect(await new ConsentWithdrawalService(db).revoke(grant, await customer())).toBe(false);
    expect(await new ConsentWithdrawalService(db).revoke(grant, id)).toBe(true);
    await enabled.join(id, await raw(id));
    expect((await new CommunityPlatformStateService(db).suspend(id, { reason: 'Synthetic safety operation.' }, audit())).membership.status).toBe('suspended');
  });

  it('request snapshots are explicit: captured enablement can finish; a fresh disabled service denies', async () => {
    const { id, input } = await prepare('join');
    const config: CommunityMembershipControlConfig = { COMMUNITY_MEMBERSHIP_JOIN_ENABLED: 'true' };
    const oldRequest = new CommunityMembershipService(db, config);
    config.COMMUNITY_MEMBERSHIP_JOIN_ENABLED = 'false';
    await expect(new CommunityMembershipService(db, config).join(id, input)).rejects.toMatchObject({ status: 503 });
    expect((await oldRequest.join(id, input)).membership.status).toBe('active');
    await expect(new CommunityMembershipService(db, config).join(id, input)).rejects.toMatchObject({ status: 503 });
  });
});
