import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildRegistrationProofLink } from '../../../../src/customer-auth/customer-email-auth.delivery';
import type { MailboxConfig } from '../guard';
import { LINK_LIFETIME_MS, RestrictedVerificationMailbox, type MessageSource } from '../verification-mailbox';
import { MAILBOX_ADAPTERS } from './index';
import { SPOOL_ENV, createLocalSpoolSource, spoolFileName } from './local-spool';
import { deliverToSpool } from './local-spool-writer';
import { DELIVERY_KEY_ENV, SPOOL_FORMAT_VERSION, signMessage } from './spool-envelope';

/**
 * MOCK-BACKED: these tests use the local spool and a fixture delivery boundary. They prove the adapter and its restrictions; they are NOT a
 * real mailbox integration and not live staging acceptance.
 */
const WEB = 'echo-grid-feedback-web-staging.example.workers.dev';
const config: MailboxConfig = { approved: true, approvedBy: 'owner', adapter: 'local-spool', allowedRecipientDomains: ['mail.example.test'] };
const KEY = 'k'.repeat(40);
const NOW = 2_000_000_000_000;
const RUN = 'abc123';
const R = `acc-${RUN}-one@mail.example.test`;
const PROOF = 'ab12'.repeat(16);
const CHALLENGE = '8142403d-073a-4ff9-9d4d-4f7a07b5c550';
const LINK = buildRegistrationProofLink(`https://${WEB}`, CHALLENGE, PROOF);

const spool = async (mode = 0o700) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'spool-'));
  await chmod(dir, mode);
  return dir;
};
const envFor = (dir: string, key: string | undefined = KEY): Record<string, string | undefined> => ({ [SPOOL_ENV]: dir, [DELIVERY_KEY_ENV]: key });
const deliver = (dir: string, text = `Confirm ${LINK}`, at = NOW - 1000, to = R) => deliverToSpool({ env: envFor(dir), to, text, receivedAtMs: at });
const box = (dir: string, over: Partial<ConstructorParameters<typeof RestrictedVerificationMailbox>[0]> = {}, runId = RUN) =>
  new RestrictedVerificationMailbox({ runId, config, webHost: WEB, source: createLocalSpoolSource(envFor(dir)), now: () => NOW, sleep: async () => {}, attempts: 1, ...over });
const ask = (b: RestrictedVerificationMailbox, recipient = R, sinceMs = NOW - 5000) => b.fetchVerification({ recipient, purpose: 'customer-signup-link', sinceMs });
const file = (dir: string, recipient = R) => path.join(dir, spoolFileName(recipient));
const rewrite = async (dir: string, mutate: (f: { version: number; messages: any[] }) => void, recipient = R) => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const parsed = JSON.parse(await readFile(file(dir, recipient), 'utf8'));
  mutate(parsed);
  await writeFile(file(dir, recipient), JSON.stringify(parsed), { mode: 0o600 });
};

describe('local-spool adapter: configuration (fails closed)', () => {
  it('is registered under the name the configuration must use', () => {
    expect(Object.keys(MAILBOX_ADAPTERS)).toEqual(['local-spool', 'cloudflare-receiver']);
  });
  it('refuses a missing or relative directory, a missing or short delivery key, and a missing directory on disk, by name only', async () => {
    expect(() => createLocalSpoolSource({})).toThrow(/ACCEPTANCE_MAILBOX_SPOOL_DIR/);
    expect(() => createLocalSpoolSource({ [SPOOL_ENV]: 'relative/dir', [DELIVERY_KEY_ENV]: KEY })).toThrow(/absolute/);
    const dir = await spool();
    expect(() => createLocalSpoolSource({ [SPOOL_ENV]: dir })).toThrow(/ACCEPTANCE_MAILBOX_DELIVERY_KEY/);
    expect(() => createLocalSpoolSource({ [SPOOL_ENV]: dir, [DELIVERY_KEY_ENV]: 'short' })).toThrow(/at least 32/);
    expect(() => createLocalSpoolSource({ [SPOOL_ENV]: path.join(dir, 'missing'), [DELIVERY_KEY_ENV]: KEY })).toThrow(/existing directory/);
    try { createLocalSpoolSource({ [SPOOL_ENV]: dir, [DELIVERY_KEY_ENV]: 'short-secret-key' }); } catch (e) { expect((e as Error).message).not.toContain('short-secret-key'); }
  });
  it('refuses a directory that group or others can read or write (a place where messages could be read or injected)', async () => {
    for (const mode of [0o750, 0o755, 0o770, 0o777]) {
      const dir = await spool(mode);
      expect(() => createLocalSpoolSource(envFor(dir)), mode.toString(8)).toThrow(/group or others/);
      await expect(deliver(dir)).rejects.toThrow(/group or others/);
    }
    const private700 = await spool(0o700);
    expect(() => createLocalSpoolSource(envFor(private700))).not.toThrow();
  });
});

describe('local-spool adapter: retrieval', () => {
  it('returns the verification from the one authenticated file of this recipient', async () => {
    const dir = await spool();
    await deliver(dir);
    await expect(ask(box(dir))).resolves.toEqual({ kind: 'link', url: LINK });
  });
  it('no file means no message yet (a deterministic refusal after polling), not an error about the file', async () => {
    await expect(ask(box(await spool()))).rejects.toMatchObject({ code: 'OTP_REFUSED', message: 'No verification arrived in time.' });
  });
  it('delayed delivery: the message that arrives after the first poll is found', async () => {
    const dir = await spool();
    let polls = 0;
    const b = box(dir, { attempts: 4, sleep: async () => { if (++polls === 2) await deliver(dir); } });
    await expect(ask(b)).resolves.toMatchObject({ kind: 'link' });
    expect(polls).toBe(2);
  });
  it('duplicate delivery: the same message delivered twice still yields one result and one evidence record', async () => {
    const dir = await spool();
    await deliver(dir);
    await deliver(dir);
    const b = box(dir);
    await expect(ask(b)).resolves.toEqual({ kind: 'link', url: LINK });
    expect(b.evidence()).toHaveLength(1);
  });
  it('a newer delivery supersedes an older one', async () => {
    const dir = await spool();
    const newer = buildRegistrationProofLink(`https://${WEB}`, CHALLENGE, 'cd34'.repeat(16));
    await deliver(dir, `Confirm ${LINK}`, NOW - 4000);
    await deliver(dir, `Confirm ${newer}`, NOW - 500);
    await expect(ask(box(dir))).resolves.toEqual({ kind: 'link', url: newer });
  });
});

describe('local-spool adapter: isolation and freshness', () => {
  it('another run cannot use this run\'s message (the recipient binds the run)', async () => {
    const dir = await spool();
    await deliver(dir);
    await expect(ask(box(dir, {}, 'zzz999'))).rejects.toMatchObject({ code: 'RECIPIENT_NOT_ALLOWED' });
  });
  it('a message the boundary bound to a DIFFERENT run is refused even under this run\'s recipient and a valid signature', async () => {
    const dir = await spool();
    await deliver(dir);
    const msg = { to: R, runId: 'zzz999', receivedAtMs: NOW - 1000, text: `Confirm ${LINK}` };
    await rewrite(dir, (f) => { f.messages = [{ ...msg, mac: signMessage(KEY, msg) }]; });
    await expect(ask(box(dir))).rejects.toMatchObject({ code: 'RECIPIENT_NOT_ALLOWED', message: 'The mailbox returned a message bound to another run.' });
  });
  it('a stale message in the file is never used', async () => {
    const dir = await spool();
    await deliver(dir, `Confirm ${LINK}`, NOW - 3_600_000);
    await expect(ask(box(dir))).rejects.toMatchObject({ code: 'OTP_REFUSED' });
  });
  it('an expired confirmation link is refused even though it arrived inside the wait window', async () => {
    const dir = await spool();
    await deliver(dir, `Confirm ${LINK}`, NOW - LINK_LIFETIME_MS - 1000);
    await expect(ask(box(dir, { maxAgeMs: 3_600_000 }), R, NOW - LINK_LIFETIME_MS - 5000)).rejects.toMatchObject({ code: 'OTP_REFUSED', message: 'The confirmation link has expired.' });
    const ok = await spool();
    await deliver(ok, `Confirm ${LINK}`, NOW - LINK_LIFETIME_MS + 1000);
    await expect(ask(box(ok, { maxAgeMs: 3_600_000 }), R, NOW - LINK_LIFETIME_MS - 5000)).resolves.toMatchObject({ kind: 'link' });
  });
  it('a file that contains another recipient\'s message is refused, not filtered', async () => {
    const dir = await spool();
    await deliver(dir);
    const other = 'acc-abc123-two@mail.example.test';
    const msg = { to: other, runId: RUN, receivedAtMs: NOW - 1000, text: `Confirm ${LINK}` };
    await rewrite(dir, (f) => { f.messages = [{ ...msg, mac: signMessage(KEY, msg) }]; });
    await expect(ask(box(dir))).rejects.toMatchObject({ code: 'RECIPIENT_NOT_ALLOWED' });
  });
});

describe('local-spool adapter: message authenticity (a file name proves nothing)', () => {
  it('refuses an unsigned message (the pre-E2C format), a wrong key, and a signature for another recipient', async () => {
    const dir = await spool();
    await writeFile(file(dir), JSON.stringify({ version: SPOOL_FORMAT_VERSION, messages: [{ to: R, runId: RUN, receivedAtMs: NOW - 1000, text: `Confirm ${LINK}` }] }), { mode: 0o600 });
    await expect(ask(box(dir))).rejects.toMatchObject({ code: 'OTP_REFUSED', message: 'A mailbox message failed authentication.' });
    const wrongKey = await spool();
    await deliverToSpool({ env: envFor(wrongKey, 'w'.repeat(40)), to: R, text: `Confirm ${LINK}`, receivedAtMs: NOW - 1000 });
    await expect(ask(box(wrongKey))).rejects.toMatchObject({ message: 'A mailbox message failed authentication.' });
    const swap = await spool();
    await deliver(swap, `Confirm ${LINK}`, NOW - 1000, 'acc-abc123-two@mail.example.test');
    const stolen = JSON.parse(await readFile(file(swap, 'acc-abc123-two@mail.example.test'), 'utf8'));
    stolen.messages[0].to = R;
    await writeFile(file(swap), JSON.stringify(stolen), { mode: 0o600 });
    await expect(ask(box(swap))).rejects.toMatchObject({ message: 'A mailbox message failed authentication.' });
  });
  it('a tampered challenge proof, text, time or run breaks the signature', async () => {
    const mutations: Array<(m: any) => void> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      (m) => { m.text = m.text.replace(PROOF, 'cd34'.repeat(16)); },
      (m) => { m.text += ' '; },
      (m) => { m.receivedAtMs += 1; },
      (m) => { m.runId = 'zzz999'; },
      (m) => { m.mac = 'f'.repeat(64); },
      (m) => { m.mac = 'not-a-mac'; },
    ];
    for (const mutate of mutations) {
      const dir = await spool();
      await deliver(dir);
      await rewrite(dir, (f) => mutate(f.messages[0]));
      await expect(ask(box(dir))).rejects.toMatchObject({ code: expect.stringMatching(/OTP_REFUSED|RECIPIENT_NOT_ALLOWED/) });
    }
  });
  it('a properly signed message whose proof is not the application\'s format is still refused by the link validator', async () => {
    const dir = await spool();
    await deliver(dir, `Confirm https://${WEB}/loyalty/signup/verify#c=${CHALLENGE}.${'zz'.repeat(32)}`);
    await expect(ask(box(dir))).rejects.toMatchObject({ code: 'OTP_REFUSED', message: 'The verification link is not acceptable.' });
  });
  it('a signed link that substitutes a query for the fragment, or lacks the fragment, is refused', async () => {
    for (const text of [`https://${WEB}/loyalty/signup/verify?c=${CHALLENGE}.${PROOF}`, `https://${WEB}/loyalty/signup/verify`, `https://${WEB}/loyalty/signup/verify?x=1#c=${CHALLENGE}.${PROOF}`]) {
      const dir = await spool();
      await deliver(dir, text);
      await expect(ask(box(dir))).rejects.toMatchObject({ code: 'OTP_REFUSED' });
    }
  });
});

describe('local-spool adapter: file-system attacks', () => {
  it('rejects malformed, wrong-version, oversized and non-file entries without echoing their content', async () => {
    const dir = await spool();
    await writeFile(file(dir), 'not json with a secret ' + LINK, { mode: 0o600 });
    await expect(ask(box(dir))).rejects.toMatchObject({ code: 'OTP_REFUSED' });
    try { await ask(box(dir)); } catch (e) { expect((e as Error).message).not.toMatch(/secret|ab12ab12/); }
    await writeFile(file(dir), JSON.stringify({ version: 2, messages: [] }), { mode: 0o600 });
    await expect(ask(box(dir))).rejects.toMatchObject({ code: 'OTP_REFUSED' });
    await writeFile(file(dir), JSON.stringify({ version: SPOOL_FORMAT_VERSION, messages: 'nope' }), { mode: 0o600 });
    await expect(ask(box(dir))).rejects.toMatchObject({ code: 'OTP_REFUSED' });
    await writeFile(file(dir), 'x'.repeat(70_000), { mode: 0o600 });
    await expect(ask(box(dir))).rejects.toMatchObject({ code: 'OTP_REFUSED' });
    const d2 = await spool();
    await mkdir(file(d2));
    await expect(ask(box(d2))).rejects.toMatchObject({ code: 'OTP_REFUSED' });
  });
  it('does not follow a symbolic link out of the directory and never lists it', async () => {
    const dir = await spool();
    const outside = await spool();
    await deliver(outside);
    await symlink(file(outside), file(dir));
    await expect(ask(box(dir))).rejects.toMatchObject({ code: 'OTP_REFUSED' });
  });
  it('a hostile recipient string cannot leave the directory: the file name is a hash and nothing outside is read', async () => {
    const dir = await spool();
    const outside = await spool();
    await writeFile(path.join(outside, 'target.json'), 'x', { mode: 0o600 });
    const source = createLocalSpoolSource(envFor(dir));
    for (const hostile of ['../target', `../${path.basename(outside)}/target.json`, '/etc/passwd', 'a/../../b', '..\\..\\x', 'x\0y']) {
      await expect(source.listMessages({ recipient: hostile, sinceMs: 0 }), hostile).resolves.toEqual([]);
    }
    expect(spoolFileName('../target')).toMatch(/^[0-9a-f]{64}\.json$/);
  });
  it('the writer refuses a symlink or directory in the way, non-synthetic recipients and oversize text, and leaves no temporary file', async () => {
    const dir = await spool();
    const outside = await spool();
    await symlink(file(outside), file(dir));
    await expect(deliver(dir)).rejects.toMatchObject({ code: 'OTP_REFUSED' });
    const d2 = await spool();
    await mkdir(file(d2));
    await expect(deliver(d2)).rejects.toMatchObject({ code: 'OTP_REFUSED' });
    const d3 = await spool();
    for (const to of ['real.person@gmail.com', '../x@mail.example.test', 'acc-abc123@mail.example.test', 'acc-abc123-x@']) {
      await expect(deliverToSpool({ env: envFor(d3), to, text: 'hello', receivedAtMs: NOW })).rejects.toMatchObject({ code: 'RECIPIENT_NOT_ALLOWED' });
    }
    await expect(deliver(d3, 'x'.repeat(20_001))).rejects.toMatchObject({ code: 'OTP_REFUSED' });
    await expect(deliver(d3, '')).rejects.toMatchObject({ code: 'OTP_REFUSED' });
    expect(await readdir(d3)).toEqual([]);
  });
  it('the writer creates the file with owner-only permissions, keeps at most five messages and is atomic (no temporary leftovers)', async () => {
    const dir = await spool();
    for (let i = 0; i < 8; i++) await deliver(dir, `Confirm ${LINK} #${i}`, NOW - 1000 + i);
    const names = await readdir(dir);
    expect(names).toEqual([spoolFileName(R)]);
    expect(((await lstat(file(dir))).mode & 0o777).toString(8)).toBe('600');
    expect(JSON.parse(await readFile(file(dir), 'utf8')).messages).toHaveLength(5);
  });
});

describe('cleanup of temporary sensitive material', () => {
  it('removes the one message file after a verification has been used, and records that in the evidence', async () => {
    const dir = await spool();
    await deliver(dir);
    const b = box(dir);
    await ask(b);
    expect(await readdir(dir)).toEqual([]);
    expect(b.evidence()[0]?.cleanup).toBe('done');
  });
  it('a failing cleanup is recorded as failed and does not fail the verification; a refused retrieval removes nothing', async () => {
    const dir = await spool();
    await deliver(dir);
    const real = createLocalSpoolSource(envFor(dir));
    const failing: MessageSource = { listMessages: (q) => real.listMessages(q), consume: async () => { throw new Error('disk error with ab12ab12'); } };
    const b = new RestrictedVerificationMailbox({ runId: RUN, config, webHost: WEB, source: failing, now: () => NOW, sleep: async () => {}, attempts: 1 });
    await expect(ask(b)).resolves.toMatchObject({ kind: 'link' });
    expect(b.evidence()[0]?.cleanup).toBe('failed');
    expect(JSON.stringify(b.evidence())).not.toContain('ab12ab12');
    const refused = await spool();
    await deliver(refused, 'no link here');
    await ask(box(refused)).catch(() => undefined);
    expect(await readdir(refused)).toEqual([spoolFileName(R)]);
  });
});

describe('provider behaviour: timeout and sanitized errors (mock-backed)', () => {
  it('a source that never answers is a bounded, sanitized refusal', async () => {
    const hang: MessageSource = { listMessages: () => new Promise(() => undefined) };
    const b = new RestrictedVerificationMailbox({ runId: RUN, config, webHost: WEB, source: hang, now: () => NOW, sleep: async () => {}, attempts: 1, sourceTimeoutMs: 20 });
    await expect(ask(b)).rejects.toMatchObject({ code: 'OTP_REFUSED', message: 'The mailbox did not answer in time.' });
  });
  it('a source that throws leaks nothing: the refusal never carries its message', async () => {
    const boom: MessageSource = { listMessages: async () => { throw new Error(`token=SECRET ${LINK}`); } };
    const b = new RestrictedVerificationMailbox({ runId: RUN, config, webHost: WEB, source: boom, now: () => NOW, sleep: async () => {}, attempts: 1 });
    try { await ask(b); } catch (e) { expect((e as Error).message).toBe('The mailbox could not be read.'); expect((e as Error).message).not.toMatch(/SECRET|ab12ab12/); return; }
    throw new Error('expected a refusal');
  });
  it('the timeout does not leave a pending timer behind after a normal answer', async () => {
    vi.useFakeTimers();
    try {
      const ok: MessageSource = { listMessages: async () => [{ to: R, runId: RUN, receivedAtMs: NOW - 10, text: `Confirm ${LINK}` }] };
      const b = new RestrictedVerificationMailbox({ runId: RUN, config, webHost: WEB, source: ok, now: () => NOW, sleep: async () => {}, attempts: 1 });
      await ask(b);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('no external mailbox access', () => {
  it('a full retrieval makes no network request and imports no network module', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('network is forbidden'); });
    try {
      const dir = await spool();
      await deliver(dir);
      await expect(ask(box(dir))).resolves.toMatchObject({ kind: 'link' });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    for (const f of ['adapters/local-spool.ts', 'adapters/local-spool-writer.ts', 'adapters/spool-envelope.ts', 'adapters/index.ts', 'verification-mailbox.ts']) {
      const source = await readFile(path.join(__dirname, '..', f), 'utf8');
      expect(source, f).not.toMatch(/from 'node:(http|https|http2|net|tls|dns|dgram)'|\bfetch\s*\(|XMLHttpRequest|WebSocket/);
    }
  });
});

describe('evidence without sensitive content', () => {
  it('records only hashes, a kind, an age and a cleanup outcome, never the link, the proof or the address', async () => {
    const dir = await spool();
    await deliver(dir, `Confirm ${LINK}`, NOW - 1500);
    const b = box(dir);
    await ask(b);
    const records = b.evidence();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ purpose: 'customer-signup-link', kind: 'link', ageMs: 1500, adapter: 'local-spool', cleanup: 'done' });
    const text = JSON.stringify(records);
    expect(text).not.toMatch(/ab12ab12|8142403d|acc-abc123|mail\.example\.test|loyalty|kkkk/);
    expect(records[0]?.recipient).toMatch(/^[0-9a-f]{12}$/);
  });
  it('a refused retrieval leaves no evidence', async () => {
    const b = box(await spool());
    await ask(b).catch(() => undefined);
    expect(b.evidence()).toEqual([]);
  });
});
