/** Test fixtures: raw RFC822 messages shaped like the app's confirmation email as Cloudflare Email Routing would hand it over. */
export const DOMAIN = 'acc-test.example';
export const SENDER = 'mail.sender.example';
export const WEB = 'web.staging.example';
export const DELIVERY_KEY = 'test-delivery-key-0123456789abcdef-0123456789';
export const RETRIEVAL_KEY = 'test-retrieval-key-fedcba9876543210-9876543210';
export const PROOF = 'a'.repeat(64);
export const CHALLENGE = '11111111-2222-3333-4444-555555555555';
export const link = (host = WEB, proof = PROOF, challenge = CHALLENGE): string => `https://${host}/loyalty/signup/verify#c=${challenge}.${proof}`;

export interface RawOptions {
  to?: string;
  from?: string;
  date?: Date | null;
  messageId?: string | null;
  /** The Authentication-Results line Cloudflare prepends; null omits it. */
  authResults?: string | null;
  /** Extra headers placed AFTER Cloudflare's (anything a sender could add). */
  senderHeaders?: string[];
  html?: string | null;
  text?: string | null;
  multipart?: boolean;
}

const CRLF = '\r\n';

export function rawEmail(o: RawOptions = {}): string {
  const to = o.to ?? `acc-abcd1234-main@${DOMAIN}`;
  const url = link();
  const html = o.html === undefined ? `<div><p>Use this link.</p><p><a href="${url}" style="color:#059669;">Confirm email</a></p></div>` : o.html;
  const text = o.text === undefined ? null : o.text;
  const lines: string[] = [];
  if (o.authResults !== null) lines.push(`Authentication-Results: ${o.authResults ?? 'mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass'}`);
  lines.push(`From: Echo Grid <no-reply@${o.from ?? SENDER}>`, `To: ${to}`, 'Subject: Confirm your email to create your Echo Grid account');
  if (o.date !== null) lines.push(`Date: ${(o.date ?? new Date()).toUTCString()}`);
  if (o.messageId !== null) lines.push(`Message-ID: ${o.messageId ?? `<${Math.random().toString(16).slice(2)}@sender.example>`}`);
  lines.push(...(o.senderHeaders ?? []), 'MIME-Version: 1.0');
  if (o.multipart || (html !== null && text !== null)) {
    lines.push('Content-Type: multipart/alternative; boundary="b1"', '');
    if (text !== null) lines.push('--b1', 'Content-Type: text/plain; charset=utf-8', '', text);
    if (html !== null) lines.push('--b1', 'Content-Type: text/html; charset=utf-8', '', html);
    lines.push('--b1--', '');
  } else if (html !== null) {
    lines.push('Content-Type: text/html; charset=utf-8', '', html);
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8', '', text ?? '');
  }
  return lines.join(CRLF);
}

export const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
