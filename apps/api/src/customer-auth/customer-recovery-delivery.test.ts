import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRecoveryCancelLink,
  buildRecoveryEmailChallengeLink,
  createRecoveryEmailChallengeDelivery,
  createRecoveryNotifier,
  createRecoveryPhoneOtp,
  renderRecoveryNotice,
} from './customer-recovery-delivery';
import { isCustomerRecoveryEnabled, parsePasswordMinLength } from './customer-recovery.composition';
import type { Bindings } from '../config/env';

const BASE = 'https://app.example.test/';
const ATTEMPT = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const TOKEN = 'ab'.repeat(32);
const sent = () => {
  const emails: Array<{ to: string; subject: string; html: string }> = [];
  const texts: Array<{ to: string; body: string }> = [];
  return {
    emails, texts,
    email: { send: async (m: { to: string; subject: string; html: string }) => { emails.push(m); } },
    sms: { send: async (to: string, body: string) => { texts.push({ to, body }); } },
  };
};

describe('recovery notices', () => {
  it.each(['initiated', 'hold_started', 'cancelled', 'completed'] as const)('%s carries no OTP-, recovery-code- or password-shaped value', (kind) => {
    const r = renderRecoveryNotice(kind, { cancelLink: 'https://x.test/c#c=1', holdUntil: new Date('2026-11-17T10:00:00Z') });
    for (const text of [r.subject, r.html, r.sms]) {
      expect(text).not.toMatch(/(?<![#\w])\d{6}(?!\w)/); // a one-time code (a CSS colour such as #111827 is not one)
      expect(text).not.toMatch(/[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}/); // a recovery code
      expect(text).not.toContain('correct horse battery staple');
    }
    expect(r.sms).not.toMatch(/https?:|#c=/);
  });
  it('only initiation and hold emails carry the cancel link; SMS never does', () => {
    const link = buildRecoveryCancelLink(BASE, ATTEMPT, TOKEN);
    expect(link).toBe(`https://app.example.test/account/recovery/cancel#c=${encodeURIComponent(`${ATTEMPT}.${TOKEN}`)}`);
    expect(link).toContain('#'); // fragment, so it is not sent to servers or referrers
    expect(renderRecoveryNotice('initiated', { cancelLink: link }).html).toContain('Cancel this recovery');
    expect(renderRecoveryNotice('completed', {}).html).not.toContain('href');
  });
  it('escapes markup in link attributes', () => {
    const r = renderRecoveryNotice('initiated', { cancelLink: 'https://x.test/?a="><script>1</script>' });
    expect(r.html).not.toContain('<script>');
  });
  it('states the hold deadline in UTC', () => {
    expect(renderRecoveryNotice('hold_started', { holdUntil: new Date('2026-11-17T10:05:00Z') }).html).toContain('2026-11-17 10:05 UTC');
  });
});

describe('recovery notifier', () => {
  it('reports accepted email and SMS, sending SMS only to a supplied (verified) phone and the link only by email', async () => {
    const s = sent();
    const notify = createRecoveryNotifier({ email: s.email, sms: s.sms, webBaseUrl: BASE });
    const r = await notify({ kind: 'initiated', attemptId: ATTEMPT, cancelToken: TOKEN, recipients: { email: 'a@example.test', phone: '+15550000001' } });
    expect(r).toEqual({ email: 'accepted', phone: 'accepted' });
    expect(s.emails[0]!.html).toContain(encodeURIComponent(`${ATTEMPT}.${TOKEN}`));
    expect(JSON.stringify(s.texts)).not.toContain(TOKEN);
    const noPhone = await notify({ kind: 'cancelled', attemptId: ATTEMPT, recipients: { email: 'a@example.test', phone: null } });
    expect(noPhone).toEqual({ email: 'accepted', phone: 'skipped' });
    expect(s.texts).toHaveLength(1);
  });
  it('reports a failed email so the orchestrator fails closed; a failed SMS never turns into a success', async () => {
    const failing = createRecoveryNotifier({ email: { send: async () => { throw new Error('provider down'); } }, sms: sent().sms, webBaseUrl: BASE });
    expect((await failing({ kind: 'initiated', attemptId: ATTEMPT, cancelToken: TOKEN, recipients: { email: 'a@example.test', phone: null } })).email).toBe('failed');
    const smsDown = createRecoveryNotifier({ email: sent().email, sms: { send: async () => { throw new Error('twilio down'); } }, webBaseUrl: BASE });
    expect(await smsDown({ kind: 'completed', attemptId: ATTEMPT, recipients: { email: 'a@example.test', phone: '+15550000001' } })).toEqual({ email: 'accepted', phone: 'failed' });
  });
  it('never logs a message, recipient or token', async () => {
    const calls: string[] = [];
    for (const channel of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, channel).mockImplementation((...a: unknown[]) => { calls.push(a.map(String).join(' ')); });
    const s = sent();
    await createRecoveryNotifier({ email: s.email, sms: s.sms, webBaseUrl: BASE })({ kind: 'initiated', attemptId: ATTEMPT, cancelToken: TOKEN, recipients: { email: 'a@example.test', phone: '+15550000001' } });
    expect(calls.join('\n')).not.toMatch(/a@example\.test|\+15550000001/);
    expect(calls.join('\n')).not.toContain(TOKEN);
    vi.restoreAllMocks();
  });
});

describe('recovery email challenge delivery', () => {
  it('sends the link only to the recipient it is given and keeps the proof in the fragment', async () => {
    const s = sent();
    await createRecoveryEmailChallengeDelivery({ email: s.email, webBaseUrl: BASE })({ recipient: 'owner@example.test', challengeId: ATTEMPT, proof: TOKEN });
    expect(s.emails).toHaveLength(1);
    expect(s.emails[0]!.to).toBe('owner@example.test');
    expect(s.emails[0]!.html).toContain(buildRecoveryEmailChallengeLink(BASE, ATTEMPT, TOKEN).replace(/&/g, '&amp;'));
    expect(buildRecoveryEmailChallengeLink(BASE, ATTEMPT, TOKEN)).toContain('#c=');
  });
  it('propagates a delivery failure so the caller does not report success', async () => {
    await expect(createRecoveryEmailChallengeDelivery({ email: { send: async () => { throw new Error('x'); } }, webBaseUrl: BASE })({ recipient: 'a@example.test', challengeId: ATTEMPT, proof: TOKEN })).rejects.toThrow();
  });
});

describe('recovery phone OTP over the existing Twilio Verify service', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('sends and checks through Verify with the given phone only, approving only on status approved', async () => {
    const requests: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: URLSearchParams }) => {
      requests.push({ url, body: init.body.toString() });
      return new Response(JSON.stringify({ status: url.endsWith('VerificationCheck') ? 'approved' : 'pending' }), { status: 200 });
    }));
    const otp = createRecoveryPhoneOtp({ accountSid: 'AC1', authToken: 'secret-token', serviceSid: 'VA1' });
    await otp.send('+15550000001');
    expect(await otp.check('+15550000001', '123456')).toBe(true);
    expect(requests[0]!.url).toContain('/Services/VA1/Verifications');
    expect(requests[0]!.body).toContain('To=%2B15550000001');
    expect(requests[1]!.url).toContain('VerificationCheck');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'pending' }), { status: 200 })));
    expect(await otp.check('+15550000001', '000000')).toBe(false);
  });
});

describe('recovery gate and configuration parsing', () => {
  it('is enabled only by the exact string "true"', () => {
    for (const value of [undefined, '', 'TRUE', 'True', '1', 'yes', 'false', ' true', 'true ']) {
      expect(isCustomerRecoveryEnabled({ CUSTOMER_RECOVERY_ENABLED: value } as Bindings)).toBe(false);
    }
    expect(isCustomerRecoveryEnabled({ CUSTOMER_RECOVERY_ENABLED: 'true' } as Bindings)).toBe(true);
  });
  it('requires a strict positive integer password minimum, with no default', () => {
    expect(parsePasswordMinLength('12')).toBe(12);
    for (const v of [undefined, '', '0', '-1', '1.5', '1e2', 'abc', ' 12', '12 ', '1234', 12 as unknown]) expect(parsePasswordMinLength(v)).toBeNull();
  });
});
