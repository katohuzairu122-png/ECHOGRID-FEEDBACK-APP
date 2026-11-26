import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { ShuffleNotificationDeliveryService, SHUFFLE_INVITATION_TEMPLATE_VERSION } from '../../src/notifications/shuffle-notification-delivery.service';
import { EMPTY_POLICY_REGISTRY, MockDeliveryProvider, type ApprovedClassPolicy, type DeliveryProvider, type PolicyRegistry } from '../../src/notifications/tentaship-notification-policy';
import { makeFixtures } from './helpers/tentaship-fixtures';

/** G2 against real PostgreSQL: persisted, retry-safe delivery decisions for held Shuffle notification intents. Synthetic providers only; nothing real is sent. */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');
const policy = (over: Partial<ApprovedClassPolicy> = {}): PolicyRegistry => new Map([['campaign_invitation', { class: 'campaign_invitation', channels: ['in_app'], requiresMarketingConsent: false, templateVersion: SHUFFLE_INVITATION_TEMPLATE_VERSION, approvedByOwner: true, ...over } as ApprovedClassPolicy]]);

describe.skipIf(!databaseUrl)('G2 persisted notification delivery for Shuffle intents (real PostgreSQL)', () => {
  let client: Client; let f: ReturnType<typeof makeFixtures>; let admin: { id: string }; let biz: string; let rule: string;
  const scenario = async () => { const s = await f.shuffleScenario({ creatorId: admin.id, businessId: biz, ruleId: rule, entries: 1 }); const [i] = await f.q(`SELECT n.id, n.invitation_id FROM shuffle_notification_intents n JOIN shuffle_invitations v ON v.id = n.invitation_id WHERE v.campaign_version_id = $1`, [s.versionId]); return { ...s, intentId: i.id as string, invitationId: i.invitation_id as string }; };

  /** An invitation that has NOT been accepted (so it can still be declined/withdrawn). */
  const pending = async () => {
    const s = await f.shuffleScenario({ creatorId: admin.id, businessId: biz, ruleId: rule, entries: 0 }); const cid = await f.customer({ businessId: biz, purchase: true });
    await f.shuffle.takeEligibilitySnapshot(s.versionId, cid, f.ctx(admin.id)); const inv = await f.part.issueInvitation(s.versionId, cid, new Date(Date.now() + 3_600_000), f.ctx(admin.id));
    const [i] = await f.q(`SELECT id FROM shuffle_notification_intents WHERE invitation_id = $1`, [inv.invitation.id]); return { invitationId: inv.invitation.id as string, intentId: i.id as string };
  };

  beforeAll(async () => { client = new Client({ connectionString: databaseUrl }); await client.connect(); f = makeFixtures(client); admin = await f.user('g2-admin'); biz = await f.business('g2'); rule = await f.rule(admin.id); });
  afterAll(async () => { await client?.end(); });

  it('DEFAULT (no approved policy): every call is HELD, nothing is sent, repeat calls do not grow the history', async () => {
    const s = await scenario(); const mock = new MockDeliveryProvider('in_app');
    const svc = new ShuffleNotificationDeliveryService(f.db, EMPTY_POLICY_REGISTRY, [mock]);
    const a = await svc.dispatch(s.intentId, null); expect(a).toMatchObject({ state: 'held', attempt: 1, replayed: false }); expect(a.reasons).toContain('POLICY_NOT_APPROVED');
    const b = await svc.dispatch(s.intentId, null); expect(b).toMatchObject({ state: 'held', attempt: 1, replayed: true });
    expect(mock.sent).toHaveLength(0); expect(await svc.history(s.intentId)).toHaveLength(1);
    expect((await f.q(`SELECT delivery_state FROM shuffle_notification_intents WHERE id=$1`, [s.intentId]))[0].delivery_state).toBe('held');
  });

  it('APPROVED synthetic policy: delivered exactly once; replay returns the stored outcome; wrong template version, expired and cancelled invitations never deliver; consent is never inferred', async () => {
    const s = await scenario(); const mock = new MockDeliveryProvider('in_app');
    const svc = new ShuffleNotificationDeliveryService(f.db, policy(), [mock]);
    const a = await svc.dispatch(s.intentId, null); expect(a.state).toBe('delivered'); expect(a.providerMessageId).toContain('mock-in_app');
    const b = await svc.dispatch(s.intentId, null); expect(b).toMatchObject({ state: 'delivered', replayed: true }); expect(mock.sent).toHaveLength(1);
    await expect(f.q(`INSERT INTO shuffle_notification_deliveries (intent_id, customer_id, notification_class, channel, template_version, attempt, state, reasons) VALUES ($1,(SELECT customer_id FROM shuffle_invitations WHERE id=$2),'campaign_invitation','in_app','x',2,'delivered','[]')`, [s.intentId, s.invitationId])).rejects.toThrow(/at most once/);
    const mismatch = await scenario(); const m1 = new ShuffleNotificationDeliveryService(f.db, policy({ templateVersion: 'other_v9' }), [new MockDeliveryProvider('in_app')]).dispatch(mismatch.intentId, null);
    expect((await m1).reasons).toContain('TEMPLATE_VERSION_MISMATCH');
    const cancelled = await pending(); await f.q(`UPDATE shuffle_invitations SET status='declined' WHERE id=$1`, [cancelled.invitationId]);
    const c = await new ShuffleNotificationDeliveryService(f.db, policy(), [new MockDeliveryProvider('in_app')]).dispatch(cancelled.intentId, null); expect(c.state).toBe('blocked'); expect(c.reasons).toContain('CANCELLED');
    const expired = await scenario();
    const e = await new ShuffleNotificationDeliveryService(f.db, policy(), [new MockDeliveryProvider('in_app')]).dispatch(expired.intentId, null, new Date(Date.now() + 10 * 86_400_000)); expect(e.reasons).toContain('EXPIRED');
    // marketing consent: required by the policy, absent/false never counts, only an explicit grant for THIS recipient does
    const consent = await scenario(); const csvc = new ShuffleNotificationDeliveryService(f.db, policy({ requiresMarketingConsent: true }), [new MockDeliveryProvider('in_app')]);
    const cust = (await f.q(`SELECT customer_id FROM shuffle_invitations WHERE id=$1`, [consent.invitationId]))[0].customer_id as string;
    expect((await csvc.dispatch(consent.intentId, null)).reasons).toContain('MARKETING_CONSENT_MISSING');
    expect((await csvc.dispatch(consent.intentId, { recipientId: cust, marketing: undefined })).reasons).toContain('MARKETING_CONSENT_MISSING');
    expect((await csvc.dispatch(consent.intentId, { recipientId: crypto.randomUUID(), marketing: true })).reasons).toContain('RECIPIENT_MISMATCH');
    expect((await csvc.dispatch(consent.intentId, { recipientId: cust, marketing: true })).state).toBe('delivered');
  });

  it('RETRY: failures are recorded and retried up to the maximum, then stay failed; a real (non-synthetic) provider is refused; history is append-only and recipient-bound', async () => {
    const s = await scenario(); const flaky = new MockDeliveryProvider('in_app', 2);
    const svc = new ShuffleNotificationDeliveryService(f.db, policy(), [flaky], 3);
    expect((await svc.dispatch(s.intentId, null)).state).toBe('failed'); expect((await svc.dispatch(s.intentId, null)).state).toBe('failed');
    const ok = await svc.dispatch(s.intentId, null); expect(ok).toMatchObject({ state: 'delivered', attempt: 3 });
    const hist = await svc.history(s.intentId); expect(hist.map((h) => h.state)).toEqual(['failed', 'failed', 'delivered']);
    const dead = await scenario(); const never = new MockDeliveryProvider('in_app', 99); const dsvc = new ShuffleNotificationDeliveryService(f.db, policy(), [never], 2);
    await dsvc.dispatch(dead.intentId, null); await dsvc.dispatch(dead.intentId, null); const last = await dsvc.dispatch(dead.intentId, null); expect(last).toMatchObject({ state: 'failed' });
    expect((await dsvc.dispatch(dead.intentId, null)).replayed).toBe(true);
    const real = await scenario(); const realProvider = { channel: 'in_app', synthetic: false, send: async () => ({ providerMessageId: 'x' }) } as DeliveryProvider;
    expect((await new ShuffleNotificationDeliveryService(f.db, policy(), [realProvider]).dispatch(real.intentId, null)).reasons).toEqual(['NOT_SYNTHETIC_PROVIDER']);
    const row = hist[0]!;
    await expect(f.q(`UPDATE shuffle_notification_deliveries SET state='delivered' WHERE id=$1`, [row.id])).rejects.toThrow(/APPEND_ONLY/);
    await expect(f.q(`DELETE FROM shuffle_notification_deliveries WHERE id=$1`, [row.id])).rejects.toThrow(/APPEND_ONLY/);
    await expect(f.q(`TRUNCATE shuffle_notification_deliveries`)).rejects.toThrow();
    const other = await f.customer({ businessId: biz });
    await expect(f.q(`INSERT INTO shuffle_notification_deliveries (intent_id, customer_id, notification_class, channel, template_version, attempt, state, reasons) VALUES ($1,$2,'campaign_invitation','in_app','x',9,'held','[]')`, [dead.intentId, other])).rejects.toThrow(/recipient/);
    await expect(f.q(`INSERT INTO shuffle_notification_deliveries (intent_id, customer_id, notification_class, channel, template_version, attempt, state, reasons, synthetic) VALUES ($1,(SELECT customer_id FROM shuffle_invitations WHERE id=$2),'campaign_invitation','in_app','x',9,'held','[]', false)`, [dead.intentId, dead.invitationId])).rejects.toThrow();
  });
});
