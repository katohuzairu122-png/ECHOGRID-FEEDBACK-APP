import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { pbkdf2Hash } from '../../src/auth/password';
import { createEmailRegistrationService } from '../../src/customer-auth/customer-email-auth.service';
import { createRegistrationProofDelivery } from '../../src/customer-auth/customer-email-auth.delivery';
import type { EmailMessage } from '../../src/notifications/email.service';
import { parseTargetsConfig, type FetchFn } from '../../scripts/acceptance/cashier-02/guard';
import { RestrictedVerificationMailbox } from '../../scripts/acceptance/cashier-02/verification-mailbox';
import { createReceiverSource } from '../../scripts/acceptance/cashier-02/adapters/cloudflare-receiver';
import { DELIVERY_KEY_ENV } from '../../scripts/acceptance/cashier-02/adapters/spool-envelope';
import { RECEIVER_HOST_ENV, RETRIEVAL_KEY_ENV } from '../../scripts/acceptance/cashier-02/adapters/receiver-protocol';
import stagingTargets from '../../scripts/acceptance/cashier-02/staging-targets.json';

/**
 * CASHIER-AUTH-02E E2D: the receiver, end to end, in an ISOLATED LOCAL environment. MOCK-BACKED: it is NOT live staging acceptance.
 *
 *   real registration service + real confirmation-email builder (against a local Postgres)
 *     -> a delivery that stands in for Cloudflare Email Routing (it adds the Authentication-Results header Cloudflare would prepend)
 *     -> the REAL receiver Worker running locally in workerd (`wrangler dev --local`, own temporary state)
 *     -> the REAL receiver-backed harness adapter inside the REAL RestrictedVerificationMailbox
 *     -> the real application verification (completeRegistration).
 * Nothing leaves the machine: the receiver host is rewritten to a loopback port, no DNS, no Cloudflare, no mailbox, no staging.
 */
const DELIVERY = 'integration-delivery-key-0123456789abcdef-01';
const RETRIEVAL = 'integration-retrieval-key-fedcba9876543210-98';
const DOMAIN = 'acc-e2d.example';
const SENDER = 'mail.sender.example';
const RECEIVER_HOST = 'receiver.acc-e2d.example';
const config = parseTargetsConfig(stagingTargets);
const WEB = config.targets.web.host;
const mailboxConfig = { approved: true, approvedBy: 'integration-test', adapter: 'cloudflare-receiver', allowedRecipientDomains: [DOMAIN], receiverHost: RECEIVER_HOST };

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  s.on('error', reject);
});

describe.skipIf(!process.env.DATABASE_URL)('E2D receiver, end to end (isolated local environment; mock-backed, not live acceptance)', () => {
  const hmacSecret = 'integration-only-hmac-key-with-more-than-thirty-two-bytes';
  let client: Client;
  let child: ChildProcess;
  let base = '';
  let stateDir = '';
  let logs = '';
  const challengeIds: string[] = [];
  const emails: string[] = [];

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    stateDir = await mkdtemp(path.join(os.tmpdir(), 'e2d-state-'));
    const vars = { ALLOWED_RECIPIENT_DOMAIN: DOMAIN, ALLOWED_SENDER_DOMAINS: SENDER, CONFIRMATION_LINK_HOSTS: WEB, ACCEPTANCE_MAILBOX_DELIVERY_KEY: DELIVERY, ACCEPTANCE_RECEIVER_RETRIEVAL_KEY: RETRIEVAL };
    child = spawn('pnpm', ['exec', 'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', stateDir, ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])], {
      cwd: path.resolve(__dirname, '../../../mail-receiver'),
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => { logs += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { logs += d.toString(); });
    for (let i = 0; i < 90; i++) {
      try { if ((await fetch(`${base}/health`)).status === 200) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('the local receiver did not start');
  }, 60_000);

  afterAll(async () => {
    child?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    await client?.query('DELETE FROM customers WHERE id IN (SELECT customer_id FROM customer_credentials WHERE login_email = ANY($1::text[]))', [emails]).catch(() => undefined);
    await client?.query('DELETE FROM customer_auth_challenges WHERE id = ANY($1::uuid[])', [challengeIds]).catch(() => undefined);
    await client?.end();
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  });

  /** The ONLY rewriting: the approved receiver host becomes the loopback port. Any other host is refused. */
  const localFetch: FetchFn = async (url, init) => {
    const u = new URL(url);
    if (u.hostname !== RECEIVER_HOST || u.protocol !== 'https:') throw new Error('the adapter tried to reach a host other than the approved receiver');
    return fetch(`${base}${u.pathname}`, init);
  };
  const env = { [RECEIVER_HOST_ENV]: RECEIVER_HOST, [RETRIEVAL_KEY_ENV]: RETRIEVAL, [DELIVERY_KEY_ENV]: DELIVERY };
  const mailboxFor = (runId: string) => new RestrictedVerificationMailbox({
    runId, config: mailboxConfig, webHost: WEB, source: createReceiverSource(env, mailboxConfig, { fetch: localFetch }), attempts: 3, pollMs: 150,
  });

  /** What Cloudflare Email Routing does: prepend its Authentication-Results, then call the Worker with the envelope recipient. */
  async function deliverLikeCloudflare(to: string, message: EmailMessage, o: { dmarc?: string; from?: string; date?: Date } = {}): Promise<{ ok: boolean }> {
    const raw = [
      `Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; ${o.dmarc ?? 'dmarc=pass'}`,
      `From: Echo Grid <no-reply@${o.from ?? SENDER}>`, `To: ${to}`, `Subject: ${message.subject}`,
      `Date: ${(o.date ?? new Date()).toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@sender.example>`,
      'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', message.html,
    ].join('\r\n');
    const res = await fetch(`${base}/cdn-cgi/handler/email?from=${encodeURIComponent(`no-reply@${o.from ?? SENDER}`)}&to=${encodeURIComponent(to)}`, { method: 'POST', body: raw });
    return { ok: res.ok };
  }

  function registration(sent: EmailMessage[]) {
    const emailService = { async send(m: EmailMessage) { sent.push(m); } };
    return createEmailRegistrationService({
      db: buildDb(client), hmacSecret, passwordPolicy: { minLength: 12 },
      hasher: { hash: (p) => pbkdf2Hash(p, 1000), verify: async () => false },
      deliver: createRegistrationProofDelivery({ email: emailService, webBaseUrl: `https://${WEB}` }),
    });
  }
  const runIdOf = () => `e${Math.random().toString(36).slice(2, 10)}`.slice(0, 9);
  const fragmentOf = (url: string) => { const m = /#c=([0-9a-f-]{36})\.([0-9a-f]{64})$/.exec(url); if (!m) throw new Error('unexpected link'); return { challengeId: m[1] as string, proof: m[2] as string }; };
  /** Records exactly the challenge this test created (read from the email it sent), so cleanup never touches another test's rows. */
  function track(email: string, message: EmailMessage | undefined): void {
    const id = /#c=([0-9a-f-]{36})\./.exec(message?.html ?? '')?.[1];
    if (id) challengeIds.push(id);
    emails.push(email);
  }

  it('a genuine registration email reaches the receiver, is retrieved once through the restricted wrapper, and the customer completes the real verification', async () => {
    const runId = runIdOf();
    const to = `acc-${runId}-main@${DOMAIN}`;
    const sent: EmailMessage[] = [];
    const before = Date.now() - 1000;
    await registration(sent).requestProof(to);
    track(to, sent[0]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(to);
    expect((await deliverLikeCloudflare(to, sent[0]!)).ok).toBe(true);

    const mailbox = mailboxFor(runId);
    const got = await mailbox.fetchVerification({ recipient: to, purpose: 'customer-signup-link', sinceMs: before });
    expect(got.kind).toBe('link');
    if (got.kind !== 'link') throw new Error('expected a link');
    const { challengeId, proof } = fragmentOf(got.url);

    // single use at the MAILBOX: a second retrieval finds nothing
    await expect(mailboxFor(runId).fetchVerification({ recipient: to, purpose: 'customer-signup-link', sinceMs: before })).rejects.toThrow(/No verification arrived/);

    // the APPLICATION still independently enforces its own challenge: the mailbox claim did not consume it, the first completion works, the replay does not
    const reg = registration([]);
    expect((await reg.completeRegistration({ email: to, challengeId, proof, password: 'a strong synthetic password' })).ok).toBe(true);
    expect((await reg.completeRegistration({ email: to, challengeId, proof, password: 'a strong synthetic password' })).ok).toBe(false);

    // evidence and the receiver's own log never contain the proof, link, key or address
    const evidence = JSON.stringify(mailbox.evidence());
    for (const secret of [proof, challengeId, to, runId, RETRIEVAL, DELIVERY, WEB]) {
      expect(evidence).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    expect(mailbox.evidence()).toHaveLength(1);
    expect(mailbox.evidence()[0]).toMatchObject({ kind: 'link', adapter: 'cloudflare-receiver', cleanup: 'done' });
  }, 30_000);

  it('a wrong proof is refused by the application even with a genuine, retrieved link: the mailbox is not the authority', async () => {
    const runId = runIdOf();
    const to = `acc-${runId}-main@${DOMAIN}`;
    const sent: EmailMessage[] = [];
    const before = Date.now() - 1000;
    await registration(sent).requestProof(to);
    track(to, sent[0]);
    await deliverLikeCloudflare(to, sent[0]!);
    const got = await mailboxFor(runId).fetchVerification({ recipient: to, purpose: 'customer-signup-link', sinceMs: before });
    if (got.kind !== 'link') throw new Error('expected a link');
    const { challengeId } = fragmentOf(got.url);
    const bad = await registration([]).completeRegistration({ email: to, challengeId, proof: 'f'.repeat(64), password: 'a strong synthetic password' });
    expect(bad.ok).toBe(false);
  }, 30_000);

  it('mail that fails DMARC, comes from an unapproved sender, is stale, or targets another run never becomes retrievable', async () => {
    const runId = runIdOf();
    const to = `acc-${runId}-main@${DOMAIN}`;
    const sent: EmailMessage[] = [];
    await registration(sent).requestProof(to);
    track(to, sent[0]);
    const m = sent[0]!;
    expect((await deliverLikeCloudflare(to, m, { dmarc: 'dmarc=fail' })).ok).toBe(false);
    expect((await deliverLikeCloudflare(to, m, { from: 'evil.example' })).ok).toBe(false);
    expect((await deliverLikeCloudflare(to, m, { date: new Date(Date.now() - 16 * 60_000) })).ok).toBe(false);
    expect((await deliverLikeCloudflare(`alice@${DOMAIN}`, m)).ok).toBe(false);
    expect((await deliverLikeCloudflare(`acc-${runId}-main@other.example`, m)).ok).toBe(false);
    await expect(mailboxFor(runId).fetchVerification({ recipient: to, purpose: 'customer-signup-link', sinceMs: Date.now() - 1000 })).rejects.toThrow(/No verification arrived/);
  }, 30_000);

  it('another run\'s mailbox cannot read this run\'s message, even with the right keys', async () => {
    const runA = runIdOf();
    const runB = runIdOf();
    const toA = `acc-${runA}-main@${DOMAIN}`;
    const sent: EmailMessage[] = [];
    await registration(sent).requestProof(toA);
    track(toA, sent[0]);
    await deliverLikeCloudflare(toA, sent[0]!);
    await expect(mailboxFor(runB).fetchVerification({ recipient: toA, purpose: 'customer-signup-link', sinceMs: Date.now() - 1000 })).rejects.toThrow(/synthetic recipients of this run/);
    const got = await mailboxFor(runA).fetchVerification({ recipient: toA, purpose: 'customer-signup-link', sinceMs: Date.now() - 60_000 });
    expect(got.kind).toBe('link');
  }, 30_000);

  it('a wrong retrieval key is refused by the receiver, and consumes nothing', async () => {
    const runId = runIdOf();
    const to = `acc-${runId}-main@${DOMAIN}`;
    const sent: EmailMessage[] = [];
    await registration(sent).requestProof(to);
    track(to, sent[0]);
    await deliverLikeCloudflare(to, sent[0]!);
    const wrong = new RestrictedVerificationMailbox({ runId, config: mailboxConfig, webHost: WEB, source: createReceiverSource({ ...env, [RETRIEVAL_KEY_ENV]: 'x'.repeat(40) }, mailboxConfig, { fetch: localFetch }), attempts: 1 });
    await expect(wrong.fetchVerification({ recipient: to, purpose: 'customer-signup-link', sinceMs: Date.now() - 60_000 })).rejects.toThrow(/refused the request/);
    expect((await mailboxFor(runId).fetchVerification({ recipient: to, purpose: 'customer-signup-link', sinceMs: Date.now() - 60_000 })).kind).toBe('link');
  }, 30_000);
});
