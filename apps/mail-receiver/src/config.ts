import type { IngestLimiterDurableObject, MailboxDurableObject } from './mailbox-do';

/**
 * CASHIER-AUTH-02E E2D: receiver configuration. Fails CLOSED: any missing or unsafe value makes the Worker refuse all mail and all
 * retrieval, with no detail in the response. Only variable NAMES are documented; no value is committed.
 */
export interface Env {
  MAILBOX: DurableObjectNamespace<MailboxDurableObject>;
  INGEST_LIMITER: DurableObjectNamespace<IngestLimiterDurableObject>;
  /** Must be exactly "acceptance-test": a receiver that is not marked as test infrastructure refuses to run. */
  RECEIVER_ENVIRONMENT?: string;
  /** The ONE approved synthetic recipient domain (apex). Owner-approved; no default. */
  ALLOWED_RECIPIENT_DOMAIN?: string;
  /** Comma-separated domains the app's confirmation email is sent from (checked only after DMARC pass). */
  ALLOWED_SENDER_DOMAINS?: string;
  /** Comma-separated approved staging WEB hosts a confirmation link may point to. */
  CONFIRMATION_LINK_HOSTS?: string;
  /** Secret: authenticates the message the receiver returns (shared with the harness as ACCEPTANCE_MAILBOX_DELIVERY_KEY). */
  ACCEPTANCE_MAILBOX_DELIVERY_KEY?: string;
  /** Secret: authenticates retrieval requests (shared with the harness as ACCEPTANCE_RECEIVER_RETRIEVAL_KEY). Independent of the delivery key. */
  ACCEPTANCE_RECEIVER_RETRIEVAL_KEY?: string;
  MAX_RAW_BYTES?: string;
  INGEST_LIMIT_PER_10_MIN?: string;
}

export interface ReceiverConfig {
  recipientDomain: string;
  senderDomains: readonly string[];
  linkHosts: readonly string[];
  deliveryKey: string;
  retrievalKey: string;
  maxRawBytes: number;
  ingestLimit: number;
}

const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MIN_KEY = 32;
const DEFAULT_MAX_RAW = 256 * 1024;
const HARD_MAX_RAW = 1024 * 1024;

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Returns null (never throws, never says why) when the configuration is not safe to run with. */
export function loadConfig(env: Env): ReceiverConfig | null {
  if (env.RECEIVER_ENVIRONMENT !== 'acceptance-test') return null;
  const recipientDomain = (env.ALLOWED_RECIPIENT_DOMAIN ?? '').trim().toLowerCase();
  if (!DOMAIN.test(recipientDomain)) return null;
  const senderDomains = list(env.ALLOWED_SENDER_DOMAINS);
  const linkHosts = list(env.CONFIRMATION_LINK_HOSTS);
  if (senderDomains.length === 0 || linkHosts.length === 0) return null;
  if (![...senderDomains, ...linkHosts].every((d) => DOMAIN.test(d))) return null;
  // The synthetic recipient domain must never be a domain the platform sends from or links to.
  if (senderDomains.includes(recipientDomain) || linkHosts.includes(recipientDomain)) return null;
  const deliveryKey = env.ACCEPTANCE_MAILBOX_DELIVERY_KEY ?? '';
  const retrievalKey = env.ACCEPTANCE_RECEIVER_RETRIEVAL_KEY ?? '';
  if (deliveryKey.length < MIN_KEY || retrievalKey.length < MIN_KEY || deliveryKey === retrievalKey) return null;
  const maxRaw = env.MAX_RAW_BYTES ? Number(env.MAX_RAW_BYTES) : DEFAULT_MAX_RAW;
  const limit = env.INGEST_LIMIT_PER_10_MIN ? Number(env.INGEST_LIMIT_PER_10_MIN) : 120;
  if (!Number.isInteger(maxRaw) || maxRaw < 1024 || maxRaw > HARD_MAX_RAW) return null;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return null;
  return { recipientDomain, senderDomains, linkHosts, deliveryKey, retrievalKey, maxRawBytes: maxRaw, ingestLimit: limit };
}
