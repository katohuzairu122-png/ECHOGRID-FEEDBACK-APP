import {
  NETWORK_LOCALES, NETWORK_MAX_BODY_CHARS, NETWORK_REASON_CODES,
  type NetworkReasonCode,
} from '../db/schema/network-posts';

/**
 * NETWORK-01 content rules (NETWORK-00 content model sections 2 and 9). Deterministic validation only: nothing here
 * approves or rejects content by itself. Plain text; one optional https link; no markup, mentions or hashtags;
 * no obvious personal data.
 */
export type NetworkContentInput = { body: string; linkUrl?: string | null | undefined; contentLocale: string };
export type NetworkContent = { body: string; linkUrl: string | null; contentLocale: (typeof NETWORK_LOCALES)[number] };

export class NetworkContentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'NetworkContentError';
  }
}

// Matching control characters is the point of this rule.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE = /(?:\+?\d[\s().-]?){7,}/;
const MENTION_OR_HASHTAG = /(^|\s)[#@][\p{L}\p{N}_]/u;

export function normalizeNetworkContent(input: NetworkContentInput): NetworkContent {
  const body = input.body.normalize('NFC').trim();
  const length = [...body].length;
  if (length < 1 || length > NETWORK_MAX_BODY_CHARS) {
    throw new NetworkContentError('body_length', `A post must be 1 to ${NETWORK_MAX_BODY_CHARS} characters.`);
  }
  if (/[<>]/.test(body) || CONTROL.test(body)) {
    throw new NetworkContentError('body_characters', 'Posts are plain text: no markup or control characters.');
  }
  if (MENTION_OR_HASHTAG.test(body)) {
    throw new NetworkContentError('body_mentions', 'Mentions and hashtags are not supported.');
  }
  if (EMAIL.test(body) || PHONE.test(body)) {
    throw new NetworkContentError('personal_data', 'A post may not contain an email address or phone number.');
  }
  if (!(NETWORK_LOCALES as readonly string[]).includes(input.contentLocale)) {
    throw new NetworkContentError('locale', 'Unsupported content language.');
  }
  let linkUrl: string | null = null;
  if (input.linkUrl !== undefined && input.linkUrl !== null && input.linkUrl.trim() !== '') {
    linkUrl = normalizeHttpsLink(input.linkUrl);
  }
  return { body, linkUrl, contentLocale: input.contentLocale as NetworkContent['contentLocale'] };
}

/** https only, parseable, no credentials, bounded length. The normalized href is what is stored and shown. */
export function normalizeHttpsLink(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new NetworkContentError('link_invalid', 'The link is not a valid URL.');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname === '') {
    throw new NetworkContentError('link_invalid', 'Only https links without credentials are allowed.');
  }
  const href = url.href;
  if (href.length > 2048 || /[\s<>"]/.test(href)) {
    throw new NetworkContentError('link_invalid', 'The link is too long or contains unsafe characters.');
  }
  return href;
}

/** SHA-256 over the canonical text, so "approved" always equals "shown" (NT-01). */
export async function computeContentDigest(content: NetworkContent): Promise<string> {
  const canonical = `${content.body}\n${content.linkUrl ?? ''}\n${content.contentLocale}`.normalize('NFC');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 22 base64url characters (128 random bits): the only public identifier of a post. */
export function newNetworkHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isNetworkReasonCode(value: unknown): value is NetworkReasonCode {
  return typeof value === 'string' && (NETWORK_REASON_CODES as readonly string[]).includes(value);
}
