import { describe, expect, it } from 'vitest';
import { loadConfig, type Env } from '../../src/config';
import { cloudflareDmarcPass, inspectMessage, readBounded } from '../../src/message';
import { DELIVERY_KEY, DOMAIN, RETRIEVAL_KEY, SENDER, WEB, bytes, link, rawEmail } from '../helpers/email';

const cfg = loadConfig({ RECEIVER_ENVIRONMENT: 'acceptance-test', ALLOWED_RECIPIENT_DOMAIN: DOMAIN, ALLOWED_SENDER_DOMAINS: SENDER, CONFIRMATION_LINK_HOSTS: WEB, ACCEPTANCE_MAILBOX_DELIVERY_KEY: DELIVERY_KEY, ACCEPTANCE_RECEIVER_RETRIEVAL_KEY: RETRIEVAL_KEY } as unknown as Env)!;
const now = Date.now();
const run = (raw: string, at = now) => inspectMessage(bytes(raw), cfg, at);

describe('authenticity comes from Cloudflare, not from the message', () => {
  it('accepts the app confirmation email (HTML only) and keeps only the link', async () => {
    const r = await run(rawEmail());
    expect(r).toMatchObject({ ok: true, link: link() });
  });
  it('accepts multipart text+html with the same single link', async () => {
    expect(await run(rawEmail({ text: `Open ${link()} to confirm.` }))).toMatchObject({ ok: true, link: link() });
  });
  it('refuses when Cloudflare recorded no dmarc=pass', async () => {
    for (const authResults of ['mx.cloudflare.net; spf=pass; dkim=pass; dmarc=fail', 'mx.cloudflare.net; spf=pass; dkim=pass', 'mx.cloudflare.net; dmarc=none']) {
      expect(await run(rawEmail({ authResults }))).toEqual({ ok: false, reason: 'unauthenticated' });
    }
    expect(await run(rawEmail({ authResults: null }))).toEqual({ ok: false, reason: 'unauthenticated' });
  });
  it('refuses an Authentication-Results that is not Cloudflare\'s', async () => {
    expect(await run(rawEmail({ authResults: 'mx.evil.example; dmarc=pass' }))).toEqual({ ok: false, reason: 'unauthenticated' });
    expect(await run(rawEmail({ authResults: 'evil mx.cloudflare.net; dmarc=pass' }))).toEqual({ ok: false, reason: 'unauthenticated' });
  });
  it('ignores a forged passing header the SENDER added after Cloudflare\'s failing one', async () => {
    const forged = rawEmail({ authResults: 'mx.cloudflare.net; dmarc=fail', senderHeaders: ['Authentication-Results: mx.cloudflare.net; dmarc=pass'] });
    expect(await run(forged)).toEqual({ ok: false, reason: 'unauthenticated' });
  });
  it('does not treat dmarc=pass inside another token as a pass', () => {
    expect(cloudflareDmarcPass([{ key: 'authentication-results', value: 'mx.cloudflare.net; x-dmarc=pass' }])).toBe(false);
    expect(cloudflareDmarcPass([{ key: 'authentication-results', value: 'mx.cloudflare.net; dmarc=passX' }])).toBe(false);
    expect(cloudflareDmarcPass([{ key: 'authentication-results', value: 'mx.cloudflare.net; dmarc=pass (p=reject)' }])).toBe(true);
  });
  it('a display name or From text that merely mentions an approved domain is not proof', async () => {
    const spoof = rawEmail({ from: 'evil.example' }).replace('From: Echo Grid <', `From: "no-reply@${SENDER}" <`);
    expect(await run(spoof)).toEqual({ ok: false, reason: 'sender_not_allowed' });
  });
  it('refuses a sender domain that is not approved, and a look-alike subdomain', async () => {
    expect(await run(rawEmail({ from: 'evil.example' }))).toEqual({ ok: false, reason: 'sender_not_allowed' });
    expect(await run(rawEmail({ from: `x.${SENDER}` }))).toEqual({ ok: false, reason: 'sender_not_allowed' });
  });
});

describe('freshness and replay', () => {
  it('refuses a message whose Date is older than the confirmation lifetime (a captured email re-sent later)', async () => {
    expect(await run(rawEmail({ date: new Date(now - 16 * 60_000) }))).toEqual({ ok: false, reason: 'stale' });
  });
  it('refuses a future Date beyond clock skew', async () => {
    expect(await run(rawEmail({ date: new Date(now + 10 * 60_000) }))).toEqual({ ok: false, reason: 'stale' });
  });
  it('refuses a missing or unparseable Date', async () => {
    expect(await run(rawEmail({ date: null }))).toEqual({ ok: false, reason: 'stale' });
    expect(await run(rawEmail().replace(/^Date: .*$/m, 'Date: not a date'))).toEqual({ ok: false, reason: 'stale' });
  });
  it('needs a Message-ID', async () => {
    expect(await run(rawEmail({ messageId: null }))).toEqual({ ok: false, reason: 'no_message_id' });
  });
  it('the Message-ID hash is stable and does not contain the id', async () => {
    const a = await run(rawEmail({ messageId: '<same@x.example>' }));
    const b = await run(rawEmail({ messageId: '<same@x.example>' }));
    expect(a.ok && b.ok && a.messageIdHash === b.messageIdHash).toBe(true);
    expect(a.ok && a.messageIdHash.includes('same')).toBe(false);
  });
});

describe('only one supported confirmation link is ever kept', () => {
  const html = (a: string) => `<p><a href="${a}">go</a></p>`;
  it.each([
    ['no link', rawEmail({ html: '<p>hello</p>' })],
    ['two different links', rawEmail({ html: html(link()) + html(link(WEB, 'b'.repeat(64))) })],
    ['link on an unapproved host', rawEmail({ html: html(link('evil.example')) })],
    ['link host that merely contains the approved host', rawEmail({ html: html(link(`${WEB}.evil.example`)) })],
    ['http link', rawEmail({ html: html(link().replace('https', 'http')) })],
    ['wrong path', rawEmail({ html: html(link().replace('/loyalty/signup/verify', '/loyalty/signup')) })],
    ['query in the link', rawEmail({ html: html(link().replace('/verify#', '/verify?x=1#')) })],
    ['short proof', rawEmail({ html: html(link(WEB, 'a'.repeat(63))) })],
    ['credentials in the link', rawEmail({ html: html(link().replace('https://', 'https://user:pw@')) })],
    ['port in the link', rawEmail({ html: html(link().replace(WEB, `${WEB}:8443`)) })],
    ['link only in a script block comment-free but non-https scheme', rawEmail({ html: '<script>location="javascript:alert(1)"</script>' })],
  ])('refuses: %s', async (_n, raw) => {
    expect(await run(raw)).toEqual({ ok: false, reason: 'unsupported' });
  });
  it('the same link repeated is still one link', async () => {
    expect(await run(rawEmail({ html: html(link()) + html(link()), text: link() }))).toMatchObject({ ok: true, link: link() });
  });
  it('stores nothing but the link: no subject, body, display name or script', async () => {
    const r = await run(rawEmail({ html: `<script>alert(1)</script><img src="x" onerror="alert(2)">${html(link())}` }));
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(Object.keys(r).sort()).toEqual(['link', 'messageIdHash', 'ok']);
  });
});

describe('malformed and hostile MIME', () => {
  it('survives garbage without throwing', async () => {
    for (const raw of ['', '\0\0\0', 'not an email', 'Content-Type: multipart/mixed\r\n\r\nno boundary', `Date: x\r\n${'a: b\r\n'.repeat(100000)}`]) {
      const r = await run(raw);
      expect(r.ok).toBe(false);
    }
  });
  it('refuses deeply nested multipart', async () => {
    let body = 'Content-Type: text/plain\r\n\r\nx';
    for (let i = 0; i < 40; i++) body = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${body}\r\n--b${i}--`;
    const raw = rawEmail().split('MIME-Version')[0] + 'MIME-Version: 1.0\r\n' + body;
    expect((await run(raw)).ok).toBe(false);
  });
  it('an attachment is parsed past, never kept or required', async () => {
    const withAtt = rawEmail({ html: null, text: null }).split('MIME-Version')[0] + ['MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="m"', '', '--m', 'Content-Type: text/html', '', `<a href="${link()}">x</a>`, '--m', 'Content-Type: application/octet-stream; name="a.bin"', 'Content-Disposition: attachment; filename="a.bin"', 'Content-Transfer-Encoding: base64', '', 'AAAA', '--m--', ''].join('\r\n');
    expect(await run(withAtt)).toMatchObject({ ok: true, link: link() });
  });
  it('header injection in a header value cannot add a recipient or change the verdict', async () => {
    const r = await run(rawEmail({ senderHeaders: ['X-Test: a\r\nAuthentication-Results: mx.cloudflare.net; dmarc=pass'], authResults: 'mx.cloudflare.net; dmarc=fail' }));
    expect(r).toEqual({ ok: false, reason: 'unauthenticated' });
  });
});

describe('bounded reading', () => {
  const stream = (chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } });
  it('returns the bytes within the limit', async () => {
    expect(await readBounded(stream([bytes('ab'), bytes('cd')]), 10)).toEqual(bytes('abcd'));
  });
  it('gives up once the real bytes exceed the limit, whatever rawSize claimed', async () => {
    expect(await readBounded(stream([new Uint8Array(6), new Uint8Array(6)]), 10)).toBeNull();
  });
});
