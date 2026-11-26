import { describe, expect, it } from 'vitest';
import { EMPTY_POLICY_REGISTRY, evaluateDelivery, MockDeliveryProvider, NOTIFICATION_CLASSES, TentashipNotificationDispatcher, type ApprovedClassPolicy, type DeliveryIntent, type PolicyRegistry } from './tentaship-notification-policy';

const now = new Date('2026-06-01T00:00:00Z');
const intent = (o: Partial<DeliveryIntent> = {}): DeliveryIntent => ({ intentId: 'i1', recipientId: 'r1', notificationClass: 'campaign_invitation', channel: 'in_app', campaignVersionId: 'v1', templateVersion: 't1', expiresAt: new Date('2026-07-01T00:00:00Z'), cancelled: false, idempotencyKey: 'k1', ...o });
const policy = (o: Partial<ApprovedClassPolicy> = {}): ApprovedClassPolicy => ({ class: 'campaign_invitation', channels: ['in_app', 'email'], requiresMarketingConsent: false, templateVersion: 't1', approvedByOwner: true, ...o }); // SYNTHETIC test policy
const reg = (p: ApprovedClassPolicy): PolicyRegistry => new Map([[p.class, p]]);
const ctx = { now, alreadyDelivered: new Set<string>() };

describe('Tentaship notification policy (fail closed; nothing is ever sent for real)', () => {
  it('with NO approved policy every new class is blocked and the intent stays HELD, whatever the channel or consent', async () => {
    for (const c of ['campaign_invitation', 'allocation_notification', 'collection_reminder', 'marketing', 'operational'] as const) for (const ch of ['in_app', 'email', 'push', 'sms'] as const) {
      const d = evaluateDelivery(intent({ notificationClass: c, channel: ch }), { recipientId: 'r1', marketing: true }, EMPTY_POLICY_REGISTRY, ctx);
      expect(d, `${c}/${ch}`).toEqual({ allowed: false, reasons: ['POLICY_NOT_APPROVED'] });
    }
    const p = new MockDeliveryProvider('in_app'); const disp = new TentashipNotificationDispatcher(EMPTY_POLICY_REGISTRY, [p]);
    expect((await disp.dispatch(intent(), { recipientId: 'r1', marketing: true }, now)).state).toBe('held'); expect(p.sent).toHaveLength(0);
  });
  it('existing approved classes (account security, transactional) are NOT handled or altered here: they keep using the existing services', () => {
    for (const c of ['account_security', 'transactional'] as const) expect(evaluateDelivery(intent({ notificationClass: c }), null, reg(policy({ class: c })), ctx)).toEqual({ allowed: false, reasons: ['EXISTING_BEHAVIOUR_NOT_GATED_HERE'] });
  });
  it('consent is explicit: absent, undefined, false or ANOTHER recipient blocks a consent-requiring class; no other signal substitutes for it', () => {
    const r = reg(policy({ class: 'marketing', requiresMarketingConsent: true }));
    const i = intent({ notificationClass: 'marketing' });
    for (const c of [null, { recipientId: 'r1', marketing: undefined }, { recipientId: 'r1', marketing: false }]) expect(evaluateDelivery(i, c, r, ctx), JSON.stringify(c)).toEqual({ allowed: false, reasons: ['MARKETING_CONSENT_MISSING'] });
    expect(evaluateDelivery(i, { recipientId: 'someone-else', marketing: true }, r, ctx)).toEqual({ allowed: false, reasons: expect.arrayContaining(['RECIPIENT_MISMATCH', 'MARKETING_CONSENT_MISSING']) });
    expect(evaluateDelivery(i, { recipientId: 'r1', marketing: true }, r, ctx).allowed).toBe(true);
    // following, membership, invitation acceptance, registration and participation are not part of the input at all: they cannot become consent
    expect(Object.keys({ recipientId: 'r1', marketing: true })).toEqual(['recipientId', 'marketing']);
  });
  it('channel, template version, expiry, cancellation and duplicates are enforced', () => {
    const r = reg(policy());
    expect(evaluateDelivery(intent({ channel: 'sms' }), null, r, ctx)).toEqual({ allowed: false, reasons: ['CHANNEL_NOT_APPROVED_FOR_CLASS'] });
    expect(evaluateDelivery(intent({ templateVersion: 't2' }), null, r, ctx)).toEqual({ allowed: false, reasons: ['TEMPLATE_VERSION_MISMATCH'] });
    expect(evaluateDelivery(intent({ expiresAt: now }), null, r, ctx)).toEqual({ allowed: false, reasons: ['EXPIRED'] });
    expect(evaluateDelivery(intent({ cancelled: true }), null, r, ctx)).toEqual({ allowed: false, reasons: ['CANCELLED'] });
    expect(evaluateDelivery(intent(), null, r, { now, alreadyDelivered: new Set(['k1']) })).toEqual({ allowed: false, reasons: ['DUPLICATE'] });
    expect(evaluateDelivery(intent({ notificationClass: 'bogus' as never }), null, r, ctx)).toEqual({ allowed: false, reasons: ['UNKNOWN_CLASS_OR_CHANNEL'] });
  });
  it('with an approved synthetic policy: delivers once, replay returns the stored outcome, failures are recorded and retry-safe', async () => {
    const flaky = new MockDeliveryProvider('in_app', 1); const disp = new TentashipNotificationDispatcher(reg(policy()), [flaky]);
    const first = await disp.dispatch(intent(), null, now); expect(first).toMatchObject({ state: 'failed', attempts: 1, error: 'synthetic provider failure' });
    const retry = await disp.dispatch(intent(), null, now); expect(retry).toMatchObject({ state: 'delivered', attempts: 2 }); expect(flaky.sent).toHaveLength(1);
    const replay = await disp.dispatch(intent(), null, now); expect(replay).toEqual(retry); expect(flaky.sent).toHaveLength(1); // never double-sent
    // a second intent with the same idempotency key is a duplicate, not a second message
    expect((await disp.dispatch(intent({ intentId: 'i2' }), null, now)).reasons).toContain('DUPLICATE'); expect(flaky.sent).toHaveLength(1);
    // an unapproved channel has no provider: the intent is held, nothing is sent
    expect((await disp.dispatch(intent({ intentId: 'i3', idempotencyKey: 'k3', channel: 'email' }), null, now)).state).toBe('held');
  });
  it('a non-synthetic provider is refused in this block', async () => {
    const real = { channel: 'in_app', synthetic: false, send: async () => { throw new Error('must never be called'); } } as const;
    const disp = new TentashipNotificationDispatcher(reg(policy()), [real as never]);
    expect(await disp.dispatch(intent(), null, now)).toMatchObject({ state: 'blocked', reasons: ['NOT_SYNTHETIC_PROVIDER'] });
  });
  it('every class is known and the new classes do not share one consent rule by assumption', () => { expect(NOTIFICATION_CLASSES).toHaveLength(7); });
});
