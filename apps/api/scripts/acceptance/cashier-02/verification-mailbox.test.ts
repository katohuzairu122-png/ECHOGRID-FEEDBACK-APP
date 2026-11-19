import { describe, expect, it } from 'vitest';
import type { MailboxConfig } from './guard';
import { FixtureMessageSource, NullVerificationMailbox, RestrictedVerificationMailbox, createVerificationMailbox, requireCredentials, type InboundMessage } from './verification-mailbox';

const WEB = 'echo-grid-feedback-web-staging.example.workers.dev';
const config: MailboxConfig = { approved: true, approvedBy: 'owner', adapter: 'fixture', allowedRecipientDomains: ['mail.example.test'] };
const NOW = 2_000_000_000_000;
const RECIPIENT = 'acc-abc123-one@mail.example.test';
const link = `https://${WEB}/loyalty/signup/verify?token=SECRETTOKENVALUE&email=x`;
const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({ to: RECIPIENT, receivedAtMs: NOW - 1000, text: `Confirm: ${link}`, ...over });
const make = (messages: InboundMessage[], over: Partial<ConstructorParameters<typeof RestrictedVerificationMailbox>[0]> = {}) => {
  const source = new FixtureMessageSource(messages);
  const box = new RestrictedVerificationMailbox({ runId: 'abc123', config, webHost: WEB, source, now: () => NOW, sleep: async () => {}, attempts: 2, ...over });
  return { box, source };
};
const ask = (box: RestrictedVerificationMailbox, over: Partial<{ recipient: string; purpose: 'customer-signup-link' | 'customer-sms-code'; sinceMs: number }> = {}) =>
  box.fetchVerification({ recipient: RECIPIENT, purpose: 'customer-signup-link', sinceMs: NOW - 5000, ...over });
const refuse = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });

describe('verification mailbox: approval and configuration', () => {
  it('is the null mailbox without approval and refuses every read deterministically', async () => {
    await refuse(NullVerificationMailbox.fetchVerification({ recipient: RECIPIENT, purpose: 'customer-signup-link', sinceMs: 0 }), 'MAILBOX_NOT_APPROVED');
    expect(createVerificationMailbox({ ...config, approved: false }, { runId: 'abc123', webHost: WEB })).toBe(NullVerificationMailbox);
    expect(() => new RestrictedVerificationMailbox({ runId: 'abc123', config: { ...config, approved: false }, webHost: WEB, source: new FixtureMessageSource([]) })).toThrow();
  });
  it('an approved mailbox with no adapter in this build is refused; credentials are named, never valued', () => {
    expect(() => createVerificationMailbox(config, { runId: 'abc123', webHost: WEB, adapters: {} })).toThrow(/adapter/);
    try { requireCredentials({ A: 'secret-value' }, ['A', 'B']); } catch (e) { expect((e as Error).message).toContain('B'); expect((e as Error).message).not.toContain('secret-value'); return; }
    throw new Error('expected a refusal');
  });
  it('builds a restricted mailbox from an adapter factory that receives only the environment', () => {
    let seen: unknown;
    const box = createVerificationMailbox(config, { runId: 'abc123', webHost: WEB, adapters: { fixture: (env) => { seen = env; return new FixtureMessageSource([]); } }, env: { X: '1' } });
    expect(box.kind).toBe('fixture');
    expect(seen).toEqual({ X: '1' });
  });
});

describe('verification mailbox: recipient binding', () => {
  it.each([
    ['an arbitrary customer address', 'real.person@gmail.com'],
    ['another run', 'acc-zzz999-one@mail.example.test'],
    ['an unapproved domain', 'acc-abc123-one@example.com'],
    ['no synthetic prefix', 'one@mail.example.test'],
    ['an owner-like address', 'owner@mail.example.test'],
  ])('refuses %s and never queries the source', async (_n, recipient) => {
    const { box, source } = make([msg()]);
    await refuse(ask(box, { recipient }), 'RECIPIENT_NOT_ALLOWED');
    expect(source.queries).toEqual([]);
  });
  it('asks the source only about the one exact recipient (no listing, no search)', async () => {
    const { box, source } = make([msg()]);
    await ask(box);
    expect(source.queries.length).toBeGreaterThan(0);
    for (const q of source.queries) expect(q.recipient).toBe(RECIPIENT);
  });
  it('refuses, rather than ignores, a source that returns another recipient\'s message', async () => {
    const { box } = make([msg(), msg({ to: 'acc-abc123-two@mail.example.test' })]);
    await refuse(ask(box), 'RECIPIENT_NOT_ALLOWED');
  });
  it('refuses a source that returns an implausible number of messages', async () => {
    const { box } = make(Array.from({ length: 26 }, () => msg()));
    await refuse(ask(box), 'OTP_REFUSED');
  });
});

describe('verification mailbox: freshness', () => {
  it('uses only a message that arrived in this run\'s window and returns the newest', async () => {
    const newer = `https://${WEB}/loyalty/signup/verify?token=NEWER`;
    const { box } = make([msg({ receivedAtMs: NOW - 4000 }), msg({ receivedAtMs: NOW - 500, text: `x ${newer}` })]);
    await expect(ask(box)).resolves.toEqual({ kind: 'link', url: newer });
  });
  it('never uses a message older than the instant it was asked to wait from', async () => {
    const { box } = make([msg({ receivedAtMs: NOW - 60_000 })]);
    await refuse(ask(box, { sinceMs: NOW - 5000 }), 'OTP_REFUSED');
  });
  it('rejects a message from the future beyond the allowed clock skew, and unusable timestamps', async () => {
    await refuse(ask(make([msg({ receivedAtMs: NOW + 10 * 60_000 })]).box), 'OTP_REFUSED');
    await refuse(ask(make([msg({ receivedAtMs: Number.NaN })]).box), 'OTP_REFUSED');
  });
  it.each([['a future window', NOW + 1], ['a window older than the limit', NOW - 3_600_000]])('refuses %s', async (_n, sinceMs) => {
    await refuse(ask(make([msg()]).box, { sinceMs }), 'OTP_REFUSED');
  });
  it('polls and succeeds when the message arrives later', async () => {
    const source = new FixtureMessageSource([]);
    let polls = 0;
    const box = new RestrictedVerificationMailbox({ runId: 'abc123', config, webHost: WEB, source, now: () => NOW, attempts: 4, sleep: async () => { if (++polls === 2) source.set([msg()]); } });
    await expect(ask(box)).resolves.toMatchObject({ kind: 'link' });
    expect(polls).toBe(2);
  });
  it('gives up deterministically when nothing arrives', async () => {
    await refuse(ask(make([]).box), 'OTP_REFUSED');
  });
});

describe('verification mailbox: what may be extracted', () => {
  it.each([
    ['a link on another host', `https://evil.example/loyalty/signup/verify?token=x`],
    ['a link on a lookalike host', `https://${WEB}.evil.example/loyalty/signup/verify?token=x`],
    ['the production web host', 'https://echo-grid.uk/loyalty/signup/verify?token=x'],
    ['another path on the right host', `https://${WEB}/loyalty/dashboard?token=x`],
    ['a link without parameters', `https://${WEB}/loyalty/signup/verify`],
    ['a link with a port', `https://${WEB}:8443/loyalty/signup/verify?token=x`],
    ['a link with credentials', `https://u:p@${WEB}/loyalty/signup/verify?token=x`],
    ['a link with a fragment', `https://${WEB}/loyalty/signup/verify?token=x#y`],
    ['plain http', `http://${WEB}/loyalty/signup/verify?token=x`],
    ['two different verification links', `https://${WEB}/loyalty/signup/verify?token=a and https://${WEB}/loyalty/signup/verify?token=b`],
    ['no link at all', 'hello'],
  ])('refuses %s', async (_n, text) => {
    await refuse(ask(make([msg({ text })]).box), 'OTP_REFUSED');
  });
  it('returns a code only when the message has exactly one six digit code', async () => {
    await expect(ask(make([msg({ text: 'Your code is 123456.' })]).box, { purpose: 'customer-sms-code' })).resolves.toEqual({ kind: 'code', value: '123456' });
    await refuse(ask(make([msg({ text: 'codes 123456 and 654321' })]).box, { purpose: 'customer-sms-code' }), 'OTP_REFUSED');
    await refuse(ask(make([msg({ text: 'code 12345' })]).box, { purpose: 'customer-sms-code' }), 'OTP_REFUSED');
    await refuse(ask(make([msg({ text: 'order 1234567' })]).box, { purpose: 'customer-sms-code' }), 'OTP_REFUSED');
  });
  it('refuses an unknown purpose and an oversized message', async () => {
    await refuse(ask(make([msg()]).box, { purpose: 'password-reset' as never }), 'OTP_REFUSED');
    await refuse(ask(make([msg({ text: 'x'.repeat(20_001) })]).box), 'OTP_REFUSED');
  });
});

describe('verification mailbox: nothing sensitive leaks', () => {
  it('no refusal message contains the link, the token or the code', async () => {
    const cases: Array<[InboundMessage, 'customer-signup-link' | 'customer-sms-code']> = [
      [msg({ text: `https://evil.example/loyalty/signup/verify?token=SECRETTOKENVALUE` }), 'customer-signup-link'],
      [msg({ text: 'codes 987654 and 123456' }), 'customer-sms-code'],
      [msg({ to: 'acc-abc123-two@mail.example.test', text: `token=SECRETTOKENVALUE 987654` }), 'customer-signup-link'],
    ];
    for (const [m, purpose] of cases) {
      try { await ask(make([m]).box, { purpose }); } catch (e) { expect(String((e as Error).message)).not.toMatch(/SECRETTOKENVALUE|987654|123456|evil\.example/); continue; }
      throw new Error('expected a refusal');
    }
  });
});
