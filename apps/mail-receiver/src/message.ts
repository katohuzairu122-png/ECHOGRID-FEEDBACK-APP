import PostalMime from 'postal-mime';
import type { ReceiverConfig } from './config';
import { MESSAGE_LIFETIME_MS, sha256Hex } from './protocol';

/**
 * CASHIER-AUTH-02E E2D: what the receiver is willing to keep from an inbound email.
 *
 * Authenticity comes from Cloudflare's own DMARC verdict, never from what the message claims about itself:
 *  - the FIRST `Authentication-Results` header (the one Cloudflare prepends, authserv-id `mx.cloudflare.net`) must say `dmarc=pass`;
 *    any later one was supplied by the sender and is ignored;
 *  - only then is the From header domain meaningful (DMARC aligned it), and it must be an approved sender domain;
 *  - the message must carry a Date within the confirmation lifetime and a Message-ID, which makes a replay of an old captured email
 *    (which would still pass DKIM) refuse itself.
 * Only ONE thing is kept: the single confirmation link on an approved web host. The body, subject, display name, attachments and all other
 * headers are discarded, so there is no stored personal content and nothing to render. No HTML is ever executed or rendered.
 */
export type RejectReason = 'too_large' | 'malformed' | 'unauthenticated' | 'sender_not_allowed' | 'stale' | 'no_message_id' | 'unsupported';

export type Inspection = { ok: true; link: string; messageIdHash: string } | { ok: false; reason: RejectReason };

export const CONFIRMATION_PATH = '/loyalty/signup/verify';
const FRAGMENT = /^#c=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{64}$/i;
const FUTURE_SKEW_MS = 2 * 60_000;

/** Reads a stream, giving up as soon as it exceeds `max` bytes (rawSize is advisory; the bytes actually read are what counts). */
export async function readBounded(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** True only if the FIRST Authentication-Results header is Cloudflare's and records dmarc=pass. */
export function cloudflareDmarcPass(headers: ReadonlyArray<{ key: string; value: string }>): boolean {
  const first = headers.find((h) => h.key.toLowerCase() === 'authentication-results');
  if (!first) return false;
  const [authservId, ...results] = first.value.split(';');
  if ((authservId ?? '').trim().split(/\s+/)[0]?.toLowerCase() !== 'mx.cloudflare.net') return false;
  return results.some((r) => /^dmarc=pass(\s|$)/i.test(r.trim()));
}

function candidateUrls(text: string | undefined, html: string | undefined): string[] {
  const found: string[] = [];
  const pick = (s: string): void => {
    for (const m of s.match(/https:\/\/[^\s"'<>)\]]+/gi) ?? []) found.push(m);
  };
  if (text) pick(text);
  if (html) {
    for (const m of html.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) found.push((m[1] ?? m[2] ?? '').replace(/&amp;/gi, '&'));
    pick(html.replace(/<[^>]*>/g, ' '));
  }
  return found;
}

function acceptableLinks(urls: string[], linkHosts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of urls) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' || !linkHosts.includes(u.hostname) || u.pathname !== CONFIRMATION_PATH) continue;
      if (u.username || u.password || u.port || u.search || !FRAGMENT.test(u.hash)) continue;
      out.add(u.toString());
    } catch {
      /* not a URL */
    }
  }
  return [...out];
}

export async function inspectMessage(raw: Uint8Array, cfg: ReceiverConfig, nowMs: number): Promise<Inspection> {
  let email;
  try {
    email = await PostalMime.parse(raw, { maxNestingDepth: 10, maxHeadersSize: 64 * 1024, maxPartCount: 50, maxRfc822NestingDepth: 1, maxForwardedAddresses: 20, attachmentEncoding: 'arraybuffer' });
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!cloudflareDmarcPass(email.headers)) return { ok: false, reason: 'unauthenticated' };
  const fromDomain = email.from?.address?.toLowerCase().split('@')[1] ?? '';
  if (!cfg.senderDomains.includes(fromDomain)) return { ok: false, reason: 'sender_not_allowed' };
  const sent = email.date ? Date.parse(email.date) : NaN;
  if (!Number.isFinite(sent) || nowMs - sent > MESSAGE_LIFETIME_MS || sent - nowMs > FUTURE_SKEW_MS) return { ok: false, reason: 'stale' };
  const messageId = email.messageId?.trim();
  if (!messageId || messageId.length > 998) return { ok: false, reason: 'no_message_id' };
  const links = acceptableLinks(candidateUrls(email.text, email.html), cfg.linkHosts);
  if (links.length !== 1) return { ok: false, reason: 'unsupported' };
  return { ok: true, link: links[0] as string, messageIdHash: await sha256Hex(messageId) };
}
