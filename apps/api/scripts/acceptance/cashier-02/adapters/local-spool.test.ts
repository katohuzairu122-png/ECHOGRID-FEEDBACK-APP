import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRegistrationProofLink } from '../../../../src/customer-auth/customer-email-auth.delivery';
import type { MailboxConfig } from '../guard';
import { RestrictedVerificationMailbox } from '../verification-mailbox';
import { MAILBOX_ADAPTERS } from './index';
import { SPOOL_ENV, createLocalSpoolSource, spoolFileName } from './local-spool';

const WEB = 'echo-grid-feedback-web-staging.example.workers.dev';
const config: MailboxConfig = { approved: true, approvedBy: 'owner', adapter: 'local-spool', allowedRecipientDomains: ['mail.example.test'] };
const NOW = 2_000_000_000_000;
const R = 'acc-abc123-one@mail.example.test';
const LINK = buildRegistrationProofLink(`https://${WEB}`, '8142403d-073a-4ff9-9d4d-4f7a07b5c550', 'ab12'.repeat(16));
const spool = async () => mkdtemp(path.join(os.tmpdir(), 'spool-'));
const write = (dir: string, recipient: string, body: unknown) => writeFile(path.join(dir, spoolFileName(recipient)), typeof body === 'string' ? body : JSON.stringify(body));
const box = (dir: string, runId = 'abc123') =>
  new RestrictedVerificationMailbox({ runId, config, webHost: WEB, source: createLocalSpoolSource({ [SPOOL_ENV]: dir }), now: () => NOW, sleep: async () => {}, attempts: 1 });
const ask = (b: RestrictedVerificationMailbox, recipient = R) => b.fetchVerification({ recipient, purpose: 'customer-signup-link', sinceMs: NOW - 5000 });

describe('local-spool adapter', () => {
  it('is registered under the name the configuration must use', () => {
    expect(Object.keys(MAILBOX_ADAPTERS)).toEqual(['local-spool']);
  });
  it('fails closed without its directory configuration (names only) or with a relative path', () => {
    expect(() => createLocalSpoolSource({})).toThrow(/ACCEPTANCE_MAILBOX_SPOOL_DIR/);
    expect(() => createLocalSpoolSource({ [SPOOL_ENV]: 'relative/dir' })).toThrow(/absolute/);
  });
  it('returns the verification from the one file of this recipient', async () => {
    const dir = await spool();
    await write(dir, R, { messages: [{ to: R, receivedAtMs: NOW - 1000, text: `Confirm ${LINK}` }] });
    await expect(ask(box(dir))).resolves.toEqual({ kind: 'link', url: LINK });
  });
  it('no file means no message yet (a deterministic refusal after polling), not an error about the file', async () => {
    await expect(ask(box(await spool()))).rejects.toMatchObject({ code: 'OTP_REFUSED', message: 'No verification arrived in time.' });
  });
  it('another run cannot use this run\'s message (the recipient binds the run)', async () => {
    const dir = await spool();
    await write(dir, R, { messages: [{ to: R, receivedAtMs: NOW - 1000, text: LINK }] });
    await expect(ask(box(dir, 'zzz999'))).rejects.toMatchObject({ code: 'RECIPIENT_NOT_ALLOWED' });
  });
  it('a stale message in the file is never used', async () => {
    const dir = await spool();
    await write(dir, R, { messages: [{ to: R, receivedAtMs: NOW - 3_600_000, text: LINK }] });
    await expect(ask(box(dir))).rejects.toMatchObject({ code: 'OTP_REFUSED' });
  });
  it('a file that contains another recipient\'s message is refused, not filtered', async () => {
    const dir = await spool();
    await write(dir, R, { messages: [{ to: 'acc-abc123-two@mail.example.test', receivedAtMs: NOW - 1000, text: LINK }] });
    await expect(ask(box(dir))).rejects.toMatchObject({ code: 'RECIPIENT_NOT_ALLOWED' });
  });
  it('rejects malformed, oversized and non-file entries without echoing their content', async () => {
    const dir = await spool();
    await write(dir, R, 'not json with a secret ' + LINK);
    await expect(ask(box(dir))).rejects.toMatchObject({ code: 'OTP_REFUSED' });
    try { await ask(box(dir)); } catch (e) { expect((e as Error).message).not.toMatch(/secret|ab12ab12/); }
    await write(dir, R, { messages: 'nope' });
    await expect(ask(box(dir))).rejects.toMatchObject({ code: 'OTP_REFUSED' });
    await write(dir, R, { messages: [{ to: R, receivedAtMs: NOW - 1000, text: 'x'.repeat(70_000) }] });
    await expect(ask(box(dir))).rejects.toMatchObject({ code: 'OTP_REFUSED' });
    const d2 = await spool();
    await mkdir(path.join(d2, spoolFileName(R)));
    await expect(ask(box(d2))).rejects.toMatchObject({ code: 'OTP_REFUSED' });
  });
  it('does not follow a symbolic link out of the directory and never lists it', async () => {
    const dir = await spool();
    const outside = await spool();
    await write(outside, R, { messages: [{ to: R, receivedAtMs: NOW - 1000, text: LINK }] });
    await symlink(path.join(outside, spoolFileName(R)), path.join(dir, spoolFileName(R)));
    await expect(ask(box(dir))).rejects.toMatchObject({ code: 'OTP_REFUSED' });
  });
  it('malformed message fields become unusable values that the wrapper then refuses', async () => {
    const dir = await spool();
    await write(dir, R, { messages: [{ to: 5, receivedAtMs: 'now', text: 7 }] });
    await expect(ask(box(dir))).rejects.toMatchObject({ code: 'RECIPIENT_NOT_ALLOWED' });
  });
});

describe('evidence without sensitive content', () => {
  it('records only hashes, a kind and an age, never the link, the proof or the address', async () => {
    const dir = await spool();
    await write(dir, R, { messages: [{ to: R, receivedAtMs: NOW - 1500, text: `Confirm ${LINK}` }] });
    const b = box(dir);
    await ask(b);
    const records = b.evidence();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ purpose: 'customer-signup-link', kind: 'link', ageMs: 1500, adapter: 'local-spool' });
    const text = JSON.stringify(records);
    expect(text).not.toMatch(/ab12ab12|8142403d|acc-abc123|mail\.example\.test|loyalty/);
    expect(records[0]?.recipient).toMatch(/^[0-9a-f]{12}$/);
  });
  it('a refused retrieval leaves no evidence', async () => {
    const b = box(await spool());
    await ask(b).catch(() => undefined);
    expect(b.evidence()).toEqual([]);
  });
});
