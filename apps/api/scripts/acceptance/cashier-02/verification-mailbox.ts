import { REGISTRATION_VERIFY_PATH } from '../../../src/customer-auth/customer-email-auth.delivery';
import { HarnessRefusal, type MailboxConfig } from './guard';

/**
 * CASHIER-AUTH-02E E2-B: retrieval of the verification a real sign-up sends to an approved synthetic test address.
 *
 * The real customer sign-up sends an EMAIL CONFIRMATION LINK (not a code); a phone sign-in sends an SMS code. Both are covered by one
 * contract. Every restriction is enforced here, in the wrapper, never in an adapter, so a future provider adapter cannot widen access:
 *  - nothing is read unless the committed configuration records the owner's approval of the mailbox;
 *  - the adapter is asked about ONE exact recipient (`acc-<runId>-<label>@<approved domain>`), never to list or search an inbox;
 *  - the adapter may only return messages addressed to that recipient: anything else is a refusal, not silently ignored;
 *  - only messages that arrived at or after the instant this run asked for them count; a stale message is never used;
 *  - a link is accepted only if it is https, on the approved WEB host, on the sign-up verification path, with the exact `#c=<id>.<proof>` fragment and no query; a code only if exactly six digits;
 *  - the value goes to the caller only and is never part of a message, an error, a log line or a result.
 */
export type VerificationPurpose = 'customer-signup-link' | 'customer-sms-code';

export interface InboundMessage {
  to: string;
  receivedAtMs: number;
  text: string;
}

/** What an adapter provides. It receives only the exact recipient and a lower time bound. */
export interface MessageSource {
  listMessages(query: { recipient: string; sinceMs: number }): Promise<InboundMessage[]>;
}

export type Verification = { kind: 'link'; url: string } | { kind: 'code'; value: string };

export interface VerificationMailbox {
  readonly kind: string;
  fetchVerification(request: { recipient: string; purpose: VerificationPurpose; sinceMs: number }): Promise<Verification>;
}

export const NullVerificationMailbox: VerificationMailbox = {
  kind: 'none',
  async fetchVerification() {
    throw new HarnessRefusal('MAILBOX_NOT_APPROVED', 'No test mailbox is approved: verification-dependent scenarios cannot run.');
  },
};

/** Single source of truth with the code that BUILDS the link (customer-email-auth.delivery.ts). */
export const SIGNUP_VERIFY_PATH = REGISTRATION_VERIFY_PATH;
/** The real link is `<web>/loyalty/signup/verify#c=<challengeId>.<proof>`: the proof travels in the fragment and there is no query. */
const SIGNUP_FRAGMENT = /^#c=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{64}$/i;
const MAX_MESSAGES = 25;
const MAX_TEXT = 20_000;
const CLOCK_SKEW_MS = 60_000;
const RUN_ID = /^[a-z0-9]{4,12}$/;
const RECIPIENT = /^acc-([a-z0-9]{4,12})-[a-z0-9]{1,16}@([a-z0-9.-]+)$/;

export interface RestrictedVerificationOptions {
  runId: string;
  config: MailboxConfig;
  /** The approved staging WEB host; the only host a verification link may point to. */
  webHost: string;
  source: MessageSource;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  pollMs?: number;
  maxAgeMs?: number;
}

export class RestrictedVerificationMailbox implements VerificationMailbox {
  readonly kind: string;
  private readonly opts: RestrictedVerificationOptions;

  constructor(opts: RestrictedVerificationOptions) {
    if (!RUN_ID.test(opts.runId)) throw new HarnessRefusal('OTP_REFUSED', 'The run identifier is not valid.');
    if (!opts.config.approved) throw new HarnessRefusal('MAILBOX_NOT_APPROVED', 'No test mailbox is approved.');
    this.opts = opts;
    this.kind = opts.config.adapter;
  }

  async fetchVerification(request: { recipient: string; purpose: VerificationPurpose; sinceMs: number }): Promise<Verification> {
    const { runId, config, webHost, source } = this.opts;
    const now = this.opts.now ?? (() => Date.now());
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    if (request.purpose !== 'customer-signup-link' && request.purpose !== 'customer-sms-code') {
      throw new HarnessRefusal('OTP_REFUSED', 'This purpose is not allowed.');
    }
    const recipient = request.recipient.toLowerCase();
    const match = RECIPIENT.exec(recipient);
    if (!match || match[1] !== runId || !config.allowedRecipientDomains.includes(match[2] ?? '')) {
      throw new HarnessRefusal('RECIPIENT_NOT_ALLOWED', 'Only synthetic recipients of this run on an approved domain may be read.');
    }
    const started = now();
    if (request.sinceMs > started || started - request.sinceMs > (this.opts.maxAgeMs ?? 15 * 60_000)) {
      throw new HarnessRefusal('OTP_REFUSED', 'The time window is not acceptable.');
    }
    const attempts = this.opts.attempts ?? 12;
    for (let i = 0; i < attempts; i++) {
      const messages = await source.listMessages({ recipient, sinceMs: request.sinceMs });
      if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) {
        throw new HarnessRefusal('OTP_REFUSED', 'The mailbox returned more messages than a single recipient can have in a run.');
      }
      for (const m of messages) {
        if (typeof m.to !== 'string' || m.to.toLowerCase() !== recipient) {
          throw new HarnessRefusal('RECIPIENT_NOT_ALLOWED', 'The mailbox returned a message for another recipient.');
        }
      }
      const fresh = messages
        .filter((m) => Number.isFinite(m.receivedAtMs) && m.receivedAtMs >= request.sinceMs && m.receivedAtMs <= now() + CLOCK_SKEW_MS)
        .sort((a, b) => b.receivedAtMs - a.receivedAtMs);
      const newest = fresh[0];
      if (newest) return extract(newest.text, request.purpose, webHost);
      if (i < attempts - 1) await sleep(this.opts.pollMs ?? 5000);
    }
    throw new HarnessRefusal('OTP_REFUSED', 'No verification arrived in time.');
  }
}

function extract(text: string, purpose: VerificationPurpose, webHost: string): Verification {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT) {
    throw new HarnessRefusal('OTP_REFUSED', 'The message could not be used.');
  }
  if (purpose === 'customer-sms-code') {
    const codes = text.match(/(?<!\d|\d\.)\d{6}(?!\d|\.\d)/g) ?? [];
    if (codes.length !== 1) throw new HarnessRefusal('OTP_REFUSED', 'The message did not contain exactly one verification code.');
    return { kind: 'code', value: codes[0] as string };
  }
  const candidates = [...new Set(text.match(/https?:\/\/[^\s"'<>)\]]+/gi) ?? [])];
  const links = candidates.filter((raw) => {
    try {
      const url = new URL(raw);
      return url.hostname === webHost && url.pathname === SIGNUP_VERIFY_PATH;
    } catch {
      return false;
    }
  });
  if (links.length !== 1) throw new HarnessRefusal('OTP_REFUSED', 'The message did not contain exactly one verification link.');
  const url = new URL(links[0] as string);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.search !== '' || !SIGNUP_FRAGMENT.test(url.hash)) {
    throw new HarnessRefusal('OTP_REFUSED', 'The verification link is not acceptable.');
  }
  return { kind: 'link', url: url.toString() };
}

/** Local tests only: canned messages. Records every query so tests can prove the adapter is only ever asked about one recipient. */
export class FixtureMessageSource implements MessageSource {
  readonly queries: Array<{ recipient: string; sinceMs: number }> = [];
  constructor(private messages: InboundMessage[]) {}
  set(messages: InboundMessage[]): void { this.messages = messages; }
  async listMessages(query: { recipient: string; sinceMs: number }): Promise<InboundMessage[]> {
    this.queries.push({ ...query });
    return this.messages;
  }
}

/** Credentials come only from the environment; a missing variable is reported by NAME, never by value. */
export function requireCredentials(env: Readonly<Record<string, string | undefined>>, names: readonly string[]): Record<string, string> {
  const missing = names.filter((n) => !env[n]);
  if (missing.length > 0) throw new HarnessRefusal('CONFIG_INVALID', `Missing mailbox credentials (names only): ${missing.join(', ')}.`);
  return Object.fromEntries(names.map((n) => [n, env[n] as string]));
}

export type MessageSourceFactory = (credentials: Readonly<Record<string, string | undefined>>) => MessageSource;

/** Without a recorded approval (the shipped state) this is the null mailbox; an approved configuration with no adapter in this build is refused. */
export function createVerificationMailbox(
  config: MailboxConfig,
  opts: { runId: string; webHost: string; adapters?: Readonly<Record<string, MessageSourceFactory>>; env?: Readonly<Record<string, string | undefined>> },
): VerificationMailbox {
  if (!config.approved) return NullVerificationMailbox;
  const factory = opts.adapters?.[config.adapter];
  if (!factory) throw new HarnessRefusal('CONFIG_INVALID', 'The configured mailbox adapter is not available in this build.');
  return new RestrictedVerificationMailbox({ runId: opts.runId, config, webHost: opts.webHost, source: factory(opts.env ?? {}) });
}
