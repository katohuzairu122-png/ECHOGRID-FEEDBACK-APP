import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTargetsConfig, type TargetsConfig } from './guard';
import { LiveCustomerProvisioner, missingApprovals, type SignupDriver } from './provisioner';
import { FixtureMessageSource, RestrictedVerificationMailbox, NullVerificationMailbox } from './verification-mailbox';

const shipped = JSON.parse(readFileSync(path.join(__dirname, 'staging-targets.json'), 'utf8')) as Record<string, unknown>;
const WEB = (shipped.targets as { web: { host: string } }).web.host;
const approvedConfig = (over: Record<string, unknown> = {}): TargetsConfig =>
  parseTargetsConfig({
    ...shipped, approved: true, approvedBy: 'owner', approvedAt: '2026-11-20',
    mailbox: { approved: true, approvedBy: 'owner', adapter: 'fixture', allowedRecipientDomains: ['mail.example.test'] },
    customerProvisioning: { approved: true, approvedBy: 'owner' },
    ...over,
  });

const NOW = 2_000_000_000_000;
function setup(over: { config?: TargetsConfig; driver?: Partial<SignupDriver> } = {}) {
  const config = over.config ?? approvedConfig();
  const calls: string[] = [];
  const source = new FixtureMessageSource([]);
  const mailbox = new RestrictedVerificationMailbox({ runId: 'abc123', config: config.mailbox, webHost: WEB, source, now: () => NOW, sleep: async () => {}, attempts: 1 });
  const driver: SignupDriver = {
    async requestSignup(email) { calls.push(`request:${email}`); source.set([{ to: email, receivedAtMs: NOW, text: `https://${WEB}/loyalty/signup/verify?token=LINKTOKEN` }]); },
    async completeSignup(url, password) { calls.push(`complete:${url.includes('LINKTOKEN')}:${password.length > 12}`); },
    async signIn(email) { calls.push(`signin:${email}`); return { customerId: `id-${email.split('@')[0]}`, accessToken: `token-${calls.length}` }; },
    ...over.driver,
  };
  const provisioner = new LiveCustomerProvisioner({ runId: 'abc123', config, mailbox, driver, now: () => NOW });
  return { provisioner, calls, source };
}

describe('provisioner approvals (all three are required)', () => {
  const mk = (config: TargetsConfig) => () => new LiveCustomerProvisioner({ runId: 'abc123', config, mailbox: NullVerificationMailbox, driver: {} as SignupDriver });
  it('the shipped configuration approves nothing', () => {
    expect(missingApprovals(parseTargetsConfig(shipped))).toEqual(['staging hostnames', 'test mailbox', 'customer provisioning']);
    expect(mk(parseTargetsConfig(shipped))).toThrowError(expect.objectContaining({ code: 'LIVE_NOT_APPROVED' }));
  });
  it('each missing approval is refused with its own code', () => {
    expect(mk(approvedConfig({ approved: false, approvedBy: null, approvedAt: null }))).toThrowError(expect.objectContaining({ code: 'LIVE_NOT_APPROVED' }));
    expect(mk(approvedConfig({ mailbox: { approved: false, approvedBy: null, adapter: 'none', allowedRecipientDomains: [] } }))).toThrowError(expect.objectContaining({ code: 'MAILBOX_NOT_APPROVED' }));
    expect(mk(approvedConfig({ customerProvisioning: { approved: false, approvedBy: null } }))).toThrowError(expect.objectContaining({ code: 'IDENTITY_NOT_APPROVED' }));
    expect(missingApprovals(approvedConfig())).toEqual([]);
  });
  it('rejects an invalid run identifier', () => {
    expect(() => new LiveCustomerProvisioner({ runId: 'BAD', config: approvedConfig(), mailbox: NullVerificationMailbox, driver: {} as SignupDriver })).toThrow();
  });
});

describe('provisioning flow', () => {
  it('creates a customer through request, mailbox link, completion and sign-in, in that order', async () => {
    const { provisioner, calls } = setup();
    const c = await provisioner.create('new1');
    expect(calls.map((x) => x.split(':')[0])).toEqual(['request', 'complete', 'signin']);
    expect(calls[0]).toBe('request:acc-abc123-new1@mail.example.test');
    expect(calls[1]).toBe('complete:true:true');
    expect(c.id).toBe('id-acc-abc123-new1');
  });
  it('asking for the same label again creates nothing new: it signs the same customer in again (a returning customer)', async () => {
    const { provisioner, calls } = setup();
    const first = await provisioner.create('ret1');
    const again = await provisioner.create('ret1');
    const returning = await provisioner.returning('ret1');
    expect(calls.filter((c) => c.startsWith('request:'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('signin:'))).toHaveLength(3);
    expect(again.id).toBe(first.id);
    expect(returning.id).toBe(first.id);
    expect(returning.token).not.toBe(first.token);
  });
  it('refuses a returning sign-in for a customer this run did not create, and one that resolves to a different customer', async () => {
    const { provisioner } = setup();
    await expect(provisioner.returning('nobody')).rejects.toMatchObject({ code: 'PROVISIONER_REFUSED' });
    let n = 0;
    const { provisioner: other } = setup({ driver: { signIn: async () => ({ customerId: `id-${++n}`, accessToken: 't' }) } });
    await other.create('swap');
    await expect(other.returning('swap')).rejects.toMatchObject({ code: 'PROVISIONER_REFUSED' });
  });
  it('refuses labels that could form a non-synthetic address, and phone-verified customers', async () => {
    const { provisioner, calls } = setup();
    for (const label of ['', 'a@b', 'UPPER', 'with space', 'x'.repeat(17), '../x']) await expect(provisioner.create(label)).rejects.toMatchObject({ code: 'PROVISIONER_REFUSED' });
    await expect(provisioner.create('phone1', { phoneVerified: true })).rejects.toMatchObject({ code: 'PROVISIONER_REFUSED' });
    expect(provisioner.canSetPhoneVerified).toBe(false);
    expect(calls).toEqual([]);
  });
  it('a failing step stops the flow, names only the step, and carries no cause', async () => {
    const { provisioner } = setup({ driver: { completeSignup: async () => { throw new Error('boom https://x/verify?token=LINKTOKEN pw=hunter2'); } } });
    try { await provisioner.create('fail1'); } catch (e) { expect((e as Error).message).toBe('customer provisioning failed at step "complete sign-up"'); return; }
    throw new Error('expected a failure');
  });
  it('without a link in the mailbox the flow stops before completing sign-up', async () => {
    const { provisioner, calls } = setup({ driver: { requestSignup: async () => {} } });
    await expect(provisioner.create('nolink')).rejects.toMatchObject({ code: 'OTP_REFUSED' });
    expect(calls).toEqual([]);
  });
});

describe('what the provisioner cannot do', () => {
  it('has no way to delete, clean up or write to a database', () => {
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(setup().provisioner)).concat(Object.keys(setup().provisioner));
    for (const n of names) expect(n).not.toMatch(/delete|clean|remove|dispose|destroy|purge|insert|sql|db|query/i);
  });
  it('never exposes the password or the link in anything it returns', async () => {
    const { provisioner } = setup();
    const out = JSON.stringify(await provisioner.create('safe1'));
    expect(out).not.toMatch(/LINKTOKEN|Acc-/);
  });
});
