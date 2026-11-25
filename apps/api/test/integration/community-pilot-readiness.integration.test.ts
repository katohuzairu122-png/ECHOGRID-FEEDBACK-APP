import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CommunityMembershipService } from '../../src/community/community-membership.service';
import { CommunityPlatformStateService } from '../../src/community/community-platform-state.service';
import { CommunityPilotEligibilityService, isCommunityPilotEligible } from '../../src/community/community-pilot-eligibility';
import { appDbOf } from '../helpers/runtime-db';
import { publishSyntheticCommunityTerms, syntheticCommunityAcceptance, SYNTHETIC_MEMBERSHIP_CONTROLS } from '../helpers/community-consent-fixtures';

/** COMMUNITY pilot allowlist and customer-deletion interplay on real PostgreSQL, with synthetic customers only. */
const url = process.env.DATABASE_URL;
if (url && !['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Disposable loopback PostgreSQL required');
const NOT_ELIGIBLE = { status: 403, code: 'COMMUNITY_PILOT_NOT_ELIGIBLE' };
const DELETION_PENDING = { status: 409, code: 'COMMUNITY_ACCOUNT_DELETION_PENDING' };

describe.skipIf(!url)('Community pilot eligibility and deletion interplay (real PostgreSQL)', () => {
  const client = new Client({ connectionString: url });
  const db = buildDb(client); // owner connection: setup and direct-SQL probes only
  const appDb = appDbOf(db); // the restricted runtime login when APP_RUNTIME_DATABASE_URL is set; services under test use this one
  const extra: Client[] = [];
  let actor: string;
  const q = async (sql: string, args: unknown[] = []) => (await client.query(sql, args)).rows;
  const repos = () => createRepositories(db);
  const audit = () => ({ actorUserId: actor, ipAddress: null, userAgent: null });
  const customer = async () => (await repos().customers.create({ phone: '+1557' + Math.floor(Math.random() * 9e8), phoneVerifiedAt: new Date() })).id;
  const svc = (config: Record<string, unknown> = {}) => new CommunityMembershipService(appDb, { ...SYNTHETIC_MEMBERSHIP_CONTROLS, ...config });
  const open = svc();
  const pilot = new CommunityPilotEligibilityService(appDb);
  const raw = (id: string) => syntheticCommunityAcceptance(open, id, 'pilot-synthetic');
  const state = async (id: string) => ({
    memberships: await q('select status, policy_version from community_memberships where customer_id=$1', [id]),
    accounts: await q('select status, points_balance from community_point_accounts where customer_id=$1', [id]),
    consents: Number((await q('select count(*)::int n from consent_grants where customer_id=$1 and purpose=$2', [id, 'community_membership']))[0].n),
    transitions: Number((await q("select count(*)::int n from audit_log where entity_type='community_membership' and metadata->>'customerId'=$1", [id]))[0].n),
  });
  const secondClient = async () => { const c = new Client({ connectionString: url }); await c.connect(); extra.push(c); return c; };

  beforeAll(async () => {
    await client.connect();
    actor = (await q("insert into users(email,password_hash,full_name,status,platform_role) values($1,'unused','Pilot synthetic','active','admin') returning id", ['pilot-' + crypto.randomUUID() + '@example.test']))[0].id;
  });
  beforeEach(async () => { await publishSyntheticCommunityTerms('pilot-synthetic'); });
  afterAll(async () => { for (const c of extra) await c.end(); await client.end(); });

  describe('pilot mode off (default)', () => {
    it.each([undefined, 'false'])('absent or "false" (%j): eligibility is not consulted and a normal Join works', async (value) => {
      const id = await customer();
      const s = svc({ COMMUNITY_MEMBERSHIP_PILOT_REQUIRED: value });
      expect((await s.getOffer(id, 'en'))?.activationAvailable).toBe(true);
      const joined = await s.join(id, await raw(id));
      expect(joined.membership.status).toBe('active');
    });
  });

  describe('pilot mode required', () => {
    it('emits one bounded, identifier-free monitoring signal for a pilot refusal (and none contain the customer id)', async () => {
      const id = await customer();
      const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      try {
        await expect(svc({ COMMUNITY_MEMBERSHIP_PILOT_REQUIRED: 'true' }).join(id, await raw(id))).rejects.toMatchObject(NOT_ELIGIBLE);
        const lines = spy.mock.calls.map((c) => String(c[0]));
        expect(lines).toContain(JSON.stringify({ event: 'community_membership.control', operation: 'activation', reason: 'pilot_not_eligible' }));
        expect(lines.some((l) => l.includes(id))).toBe(false);
      } finally { spy.mockRestore(); }
    });

    it.each(['true', 'TRUE', '', ' true', 'yes', 1, true])('%j requires eligibility (every non-"false" value fails closed) and writes nothing when refused', async (value) => {
      const id = await customer();
      const s = svc({ COMMUNITY_MEMBERSHIP_PILOT_REQUIRED: value });
      const input = await raw(id);
      const before = await state(id);
      expect((await s.getOffer(id, 'en'))?.activationAvailable).toBe(false);
      await expect(s.join(id, input)).rejects.toMatchObject(NOT_ELIGIBLE);
      expect(await state(id)).toEqual(before);
    });

    it('eligibility alone enrolls nobody; granting then Join enrolls exactly through the normal consent path', async () => {
      const id = await customer();
      const s = svc({ COMMUNITY_MEMBERSHIP_PILOT_REQUIRED: 'true' });
      await pilot.grant(id, 'synthetic pilot customer', audit());
      expect((await state(id)).memberships).toEqual([]);
      expect((await s.getOffer(id, 'en'))?.activationAvailable).toBe(true);
      const joined = await s.join(id, await raw(id));
      expect(joined.membership.status).toBe('active');
      expect((await state(id)).consents).toBe(1);
    });

    it('eligibility never replaces the other conditions: a disabled operation gate still answers 503, bad consent is still refused', async () => {
      const id = await customer();
      await pilot.grant(id, 'synthetic pilot customer', audit());
      const gated = svc({ COMMUNITY_MEMBERSHIP_PILOT_REQUIRED: 'true', COMMUNITY_MEMBERSHIP_JOIN_ENABLED: 'false' });
      await expect(gated.join(id, await raw(id))).rejects.toMatchObject({ status: 503, code: 'COMMUNITY_MEMBERSHIP_OPERATION_DISABLED' });
      const s = svc({ COMMUNITY_MEMBERSHIP_PILOT_REQUIRED: 'true' });
      await expect(s.join(id, { ...(await raw(id)), accepted: false })).rejects.toBeTruthy();
      expect((await state(id)).memberships).toEqual([]);
    });

    it('the Feed flag is irrelevant in both directions', async () => {
      const id = await customer();
      const s = svc({ COMMUNITY_MEMBERSHIP_PILOT_REQUIRED: 'true', NETWORK_FEED_ENABLED: 'true' });
      await expect(s.join(id, await raw(id))).rejects.toMatchObject(NOT_ELIGIBLE);
      await pilot.grant(id, 'synthetic pilot customer', audit());
      const off = svc({ COMMUNITY_MEMBERSHIP_PILOT_REQUIRED: 'true', NETWORK_FEED_ENABLED: 'false' });
      expect((await off.join(id, await raw(id))).membership.status).toBe('active');
    });

    it('revoking is immediate for Rejoin and Restore, preserves membership, points and consent evidence, and Leave still works', async () => {
      const id = await customer();
      const s = svc({ COMMUNITY_MEMBERSHIP_PILOT_REQUIRED: 'true' });
      await pilot.grant(id, 'synthetic pilot customer', audit());
      await s.join(id, await raw(id));
      await q('update community_point_accounts set points_balance=41 where customer_id=$1', [id]);
      await pilot.revoke(id, 'synthetic suspension of pilot', audit());
      // already-active member keeps everything (revocation stops FUTURE activations, it deletes nothing)
      expect((await state(id)).memberships[0]).toMatchObject({ status: 'active' });
      await s.leave(id);
      await expect(s.join(id, await raw(id))).rejects.toMatchObject(NOT_ELIGIBLE); // Rejoin
      const platform = new CommunityPlatformStateService(appDb, SYNTHETIC_MEMBERSHIP_CONTROLS);
      const other = await customer();
      await pilot.grant(other, 'synthetic pilot customer', audit());
      await s.join(other, await raw(other));
      await platform.suspend(other, { reason: 'Synthetic investigation.' }, audit());
      await platform.restore(other, { reason: 'Synthetic clearance.' }, audit()); // clearance -> inactive, never active
      expect((await state(other)).memberships[0]).toMatchObject({ status: 'inactive' });
      await pilot.revoke(other, 'synthetic suspension of pilot', audit());
      await expect(s.join(other, await raw(other))).rejects.toMatchObject(NOT_ELIGIBLE); // Restore
      expect((await state(id)).accounts[0]).toMatchObject({ points_balance: 41 });
    });

    it('grant and revoke are idempotent, append-only, audited with actor and reason, and only the latest event decides', async () => {
      const id = await customer();
      expect((await pilot.grant(id, 'first grant', audit())).changed).toBe(true);
      expect((await pilot.grant(id, 'duplicate grant', audit())).changed).toBe(false);
      expect((await pilot.revoke(id, 'revoke', audit())).changed).toBe(true);
      expect((await pilot.revoke(id, 'duplicate revoke', audit())).changed).toBe(false);
      expect((await pilot.grant(id, 'grant again', audit())).changed).toBe(true);
      const events = await q('select action, actor_user_id, reason from community_pilot_eligibility_events where customer_id=$1 order by seq', [id]);
      expect(events.map((e) => e.action)).toEqual(['grant', 'revoke', 'grant']);
      expect(events.every((e) => e.actor_user_id === actor && e.reason.length > 0)).toBe(true);
      const audits = await q("select action, actor_user_id from audit_log where entity_id=$1 and action like 'community.pilot_%' order by created_at, id", [id]);
      expect(audits.map((a) => a.action)).toEqual(['community.pilot_grant', 'community.pilot_revoke', 'community.pilot_grant']);
      expect((await pilot.status(id)).eligible).toBe(true);
    });

    it('the history cannot be rewritten: UPDATE, DELETE and TRUNCATE are refused even for the table owner; an unknown customer is refused', async () => {
      const id = await customer();
      await pilot.grant(id, 'synthetic', audit());
      await expect(client.query("update community_pilot_eligibility_events set action='revoke' where customer_id=$1", [id])).rejects.toThrow(/IMMUTABLE/);
      await expect(client.query('delete from community_pilot_eligibility_events where customer_id=$1', [id])).rejects.toThrow(/IMMUTABLE/);
      await expect(client.query('truncate community_pilot_eligibility_events')).rejects.toThrow(/IMMUTABLE/);
      await expect(client.query("insert into community_pilot_eligibility_events(customer_id,action,reason) values($1,'grant','   ')", [id])).rejects.toThrow(/reason_check/);
      await expect(pilot.grant(crypto.randomUUID(), 'synthetic', audit())).rejects.toMatchObject({ status: 404 });
    });

    it('a revoke waits for an in-flight activation check (shared lock) and is honoured once that transaction ends', async () => {
      const id = await customer();
      await pilot.grant(id, 'synthetic', audit());
      const holder = await secondClient();
      await holder.query('begin');
      const holderDb = buildDb(holder);
      expect(await isCommunityPilotEligible(holderDb, id)).toBe(true); // holds the shared lock until commit
      let revoked = false;
      const revoke = pilot.revoke(id, 'racing revoke', audit()).then((r) => { revoked = true; return r; });
      await new Promise((r) => setTimeout(r, 400));
      expect(revoked).toBe(false); // blocked behind the in-flight activation
      await holder.query('commit');
      await revoke;
      expect((await pilot.status(id)).eligible).toBe(false);
    });
  });

  describe('Community x customer deletion lifecycle', () => {
    const pend = (id: string) => createRepositories(appDb).customerDeletionRequests.fileOrGetPending(id, new Date());

    it('emits one bounded, identifier-free monitoring signal for a deletion conflict', async () => {
      const id = await customer();
      await pend(id);
      const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      try {
        await expect(open.join(id, await raw(id))).rejects.toMatchObject(DELETION_PENDING);
        const lines = spy.mock.calls.map((c) => String(c[0]));
        expect(lines).toContain(JSON.stringify({ event: 'community_membership.control', operation: 'activation', reason: 'deletion_pending' }));
        expect(lines.some((l) => l.includes(id))).toBe(false);
      } finally { spy.mockRestore(); }
    });

    it('a pending deletion blocks Join, Rejoin and Restore at the service level and hides activation in the offer; nothing is written', async () => {
      const fresh = await customer();
      await pend(fresh);
      const before = await state(fresh);
      expect((await open.getOffer(fresh, 'en'))?.activationAvailable).toBe(false);
      await expect(open.join(fresh, await raw(fresh))).rejects.toMatchObject(DELETION_PENDING);
      expect(await state(fresh)).toEqual(before);

      for (const operation of ['rejoin', 'restore'] as const) {
        const id = await customer();
        await open.join(id, await raw(id));
        await q('update community_point_accounts set points_balance=19 where customer_id=$1', [id]);
        if (operation === 'rejoin') await open.leave(id);
        else {
          const platform = new CommunityPlatformStateService(appDb, SYNTHETIC_MEMBERSHIP_CONTROLS);
          await platform.suspend(id, { reason: 'Synthetic investigation.' }, audit());
          await platform.restore(id, { reason: 'Synthetic clearance.' }, audit());
        }
        await pend(id);
        const snapshot = await state(id);
        await expect(open.join(id, await raw(id))).rejects.toMatchObject(DELETION_PENDING);
        expect(await state(id)).toEqual(snapshot); // membership, points and consent evidence untouched
      }
    });

    it('a pending deletion does not stop the customer leaving; restoring the deletion request re-allows Community', async () => {
      const id = await customer();
      await open.join(id, await raw(id));
      await pend(id);
      expect((await open.leave(id)).membership?.status).toBe('left');
      await expect(open.join(id, await raw(id))).rejects.toMatchObject(DELETION_PENDING);
      await createRepositories(appDb).customerDeletionRequests.cancelPending(id, new Date());
      expect((await open.join(id, await raw(id))).membership.status).toBe('active');
    });

    it('both guards apply together: pilot required and deletion pending still refuse, and the evidence history is unchanged', async () => {
      const id = await customer();
      await pilot.grant(id, 'synthetic', audit());
      await pend(id);
      const s = svc({ COMMUNITY_MEMBERSHIP_PILOT_REQUIRED: 'true' });
      await expect(s.join(id, await raw(id))).rejects.toMatchObject(DELETION_PENDING);
    });
  });
});
