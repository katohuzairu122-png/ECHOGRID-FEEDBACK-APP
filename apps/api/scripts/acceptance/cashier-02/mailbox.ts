import { HarnessRefusal, type MailboxConfig } from './guard';

/**
 * CASHIER-AUTH-02E E1: the verification-code mailbox CONTRACT.
 *
 * E1 ships the contract and its restrictions, not a live adapter: no mailbox is approved, so live OTP-dependent scenarios are NOT RUN.
 * The restrictions hold for every future adapter because they are enforced by {@link RestrictedMailbox}, not by the adapter:
 *  - nothing is read unless the configuration records the owner's approval of the mailbox;
 *  - only synthetic recipients of THIS run (`acc-<runId>-<label>@<approved domain>`) can be asked about, never an arbitrary address;
 *  - only the two sign-up and sign-in purposes exist, and only a fresh message is accepted;
 *  - the value must be a six digit code; anything else is refused without echoing the content;
 *  - the code is returned to the caller only and is never part of an error, a log line or a result.
 */
export type OtpPurpose = 'customer-signup' | 'customer-login';

export interface OtpRequest {
  recipient: string;
  purpose: OtpPurpose;
  /** Epoch milliseconds: only messages received at or after this instant may be used. */
  sinceMs: number;
}

export interface Mailbox {
  readonly kind: string;
  fetchCode(request: OtpRequest): Promise<string>;
}

/** What an adapter provides: raw access to the approved synthetic mailbox. It never sees an unapproved recipient. */
export interface RawMailbox {
  readLatestCode(recipient: string, purpose: OtpPurpose, sinceMs: number): Promise<string | null>;
}

export const NullMailbox: Mailbox = {
  kind: 'none',
  async fetchCode() {
    throw new HarnessRefusal('MAILBOX_NOT_APPROVED', 'No test mailbox is approved: OTP-dependent scenarios cannot run.');
  },
};

export interface RestrictedMailboxOptions {
  runId: string;
  config: MailboxConfig;
  raw: RawMailbox;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  pollMs?: number;
  maxAgeMs?: number;
}

const RUN_ID = /^[a-z0-9]{4,12}$/;

export class RestrictedMailbox implements Mailbox {
  readonly kind: string;
  private readonly opts: RestrictedMailboxOptions;

  constructor(opts: RestrictedMailboxOptions) {
    if (!RUN_ID.test(opts.runId)) throw new HarnessRefusal('OTP_REFUSED', 'The run identifier is not valid.');
    if (!opts.config.approved) throw new HarnessRefusal('MAILBOX_NOT_APPROVED', 'No test mailbox is approved.');
    this.opts = opts;
    this.kind = opts.config.adapter;
  }

  async fetchCode(request: OtpRequest): Promise<string> {
    const { runId, config } = this.opts;
    const now = (this.opts.now ?? (() => Date.now()))();
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    if (request.purpose !== 'customer-signup' && request.purpose !== 'customer-login') {
      throw new HarnessRefusal('OTP_REFUSED', 'This purpose is not allowed.');
    }
    const recipient = request.recipient.toLowerCase();
    const match = /^acc-([a-z0-9]{4,12})-[a-z0-9]{1,16}@([a-z0-9.-]+)$/.exec(recipient);
    if (!match || match[1] !== runId || !config.allowedRecipientDomains.includes(match[2] ?? '')) {
      throw new HarnessRefusal('RECIPIENT_NOT_ALLOWED', 'Only synthetic recipients of this run on an approved domain may be read.');
    }
    const maxAge = this.opts.maxAgeMs ?? 15 * 60_000;
    if (request.sinceMs > now || now - request.sinceMs > maxAge) {
      throw new HarnessRefusal('OTP_REFUSED', 'The time window is not acceptable.');
    }
    const attempts = this.opts.attempts ?? 12;
    for (let i = 0; i < attempts; i++) {
      const value = await this.opts.raw.readLatestCode(recipient, request.purpose, request.sinceMs);
      if (value !== null) {
        if (!/^\d{6}$/.test(value)) throw new HarnessRefusal('OTP_REFUSED', 'The message did not contain a verification code.');
        return value;
      }
      if (i < attempts - 1) await sleep(this.opts.pollMs ?? 5000);
    }
    throw new HarnessRefusal('OTP_REFUSED', 'No verification code arrived in time.');
  }
}

/** Local tests only: an in-memory mailbox of canned messages. Never constructed by the command line entry point. */
export class FixtureMailbox implements RawMailbox {
  readonly reads: string[] = [];
  constructor(private readonly messages: Map<string, string>) {}
  async readLatestCode(recipient: string): Promise<string | null> {
    this.reads.push(recipient);
    return this.messages.get(recipient) ?? null;
  }
}

/** Builds the mailbox for a run. Without a recorded approval (the shipped state) this is the null mailbox. */
export function createMailbox(config: MailboxConfig, runId: string, adapters: Readonly<Record<string, () => RawMailbox>> = {}): Mailbox {
  if (!config.approved) return NullMailbox;
  const factory = adapters[config.adapter];
  if (!factory) throw new HarnessRefusal('CONFIG_INVALID', 'The configured mailbox adapter is not available in this build.');
  return new RestrictedMailbox({ runId, config, raw: factory() });
}
