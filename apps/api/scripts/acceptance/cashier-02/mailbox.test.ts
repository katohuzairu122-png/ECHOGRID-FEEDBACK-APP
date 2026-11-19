import { describe, expect, it } from 'vitest';
import { FixtureMailbox, NullMailbox, RestrictedMailbox, createMailbox } from './mailbox';
import type { MailboxConfig } from './guard';

const config: MailboxConfig = { approved: true, approvedBy: 'owner', adapter: 'fixture', allowedRecipientDomains: ['mail.example.test'] };
const make = (messages: Record<string, string>, over: Partial<ConstructorParameters<typeof RestrictedMailbox>[0]> = {}) => {
  const raw = new FixtureMailbox(new Map(Object.entries(messages)));
  const now = 1_000_000_000;
  const box = new RestrictedMailbox({ runId: 'abc123', config, raw, now: () => now, sleep: async () => {}, attempts: 2, ...over });
  return { box, raw, now };
};
const refuse = async (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });

describe('mailbox restrictions', () => {
  it('without an approved mailbox every read is refused and nothing is read', async () => {
    await refuse(NullMailbox.fetchCode({ recipient: 'acc-abc123-x@mail.example.test', purpose: 'customer-signup', sinceMs: 0 }), 'MAILBOX_NOT_APPROVED');
    expect(createMailbox({ ...config, approved: false }, 'abc123')).toBe(NullMailbox);
    expect(() => new RestrictedMailbox({ runId: 'abc123', config: { ...config, approved: false }, raw: new FixtureMailbox(new Map()) })).toThrow();
  });
  it('returns a code only for a synthetic recipient of this run on an approved domain', async () => {
    const { box, now } = make({ 'acc-abc123-one@mail.example.test': '123456' });
    await expect(box.fetchCode({ recipient: 'acc-abc123-one@mail.example.test', purpose: 'customer-signup', sinceMs: now - 1000 })).resolves.toBe('123456');
  });
  it.each([
    ['an arbitrary customer address', 'real.person@gmail.com'],
    ['another run', 'acc-zzz999-one@mail.example.test'],
    ['an unapproved domain', 'acc-abc123-one@example.com'],
    ['no synthetic prefix', 'one@mail.example.test'],
    ['an owner address', 'owner@mail.example.test'],
  ])('refuses %s and never reads the mailbox', async (_n, recipient) => {
    const { box, raw, now } = make({ [recipient]: '123456' });
    await refuse(box.fetchCode({ recipient, purpose: 'customer-signup', sinceMs: now - 1000 }), 'RECIPIENT_NOT_ALLOWED');
    expect(raw.reads).toEqual([]);
  });
  it('refuses unknown purposes, stale or future windows, non-code content and a missing message', async () => {
    const r = 'acc-abc123-one@mail.example.test';
    const { box, now } = make({ [r]: 'hello' });
    await refuse(box.fetchCode({ recipient: r, purpose: 'password-reset' as never, sinceMs: now - 1 }), 'OTP_REFUSED');
    await refuse(box.fetchCode({ recipient: r, purpose: 'customer-login', sinceMs: now - 3_600_000 }), 'OTP_REFUSED');
    await refuse(box.fetchCode({ recipient: r, purpose: 'customer-login', sinceMs: now + 5_000 }), 'OTP_REFUSED');
    await refuse(box.fetchCode({ recipient: r, purpose: 'customer-login', sinceMs: now - 1000 }), 'OTP_REFUSED');
    const empty = make({});
    await refuse(empty.box.fetchCode({ recipient: r, purpose: 'customer-login', sinceMs: empty.now - 1000 }), 'OTP_REFUSED');
  });
  it('the refusal messages never contain the code or the message content', async () => {
    const r = 'acc-abc123-one@mail.example.test';
    const { box, now } = make({ [r]: 'your code is 987654 secret' });
    try { await box.fetchCode({ recipient: r, purpose: 'customer-login', sinceMs: now - 1000 }); } catch (e) { expect(String((e as Error).message)).not.toMatch(/987654|secret/); return; }
    throw new Error('expected a refusal');
  });
  it('rejects an invalid run identifier and an unavailable adapter', () => {
    expect(() => new RestrictedMailbox({ runId: 'BAD ID', config, raw: new FixtureMailbox(new Map()) })).toThrow();
    expect(() => createMailbox(config, 'abc123', {})).toThrow(/adapter/);
  });
});
