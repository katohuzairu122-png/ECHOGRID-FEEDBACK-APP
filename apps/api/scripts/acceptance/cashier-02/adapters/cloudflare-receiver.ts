import { randomBytes } from 'node:crypto';
import { HarnessRefusal, isProductionHost, type FetchFn, type MailboxConfig } from '../guard';
import type { InboundMessage, MessageSource } from '../verification-mailbox';
import { CLAIM_PATH, HEADER_NONCE, HEADER_SIG, HEADER_TS, RECEIVER_HOST_ENV, RETRIEVAL_KEY_ENV, signRequest } from './receiver-protocol';
import { readDeliveryKey, verifyMessage, type SpoolMessage } from './spool-envelope';

/**
 * CASHIER-AUTH-02E E2D: the "cloudflare-receiver" mailbox adapter: retrieval of a synthetic customer's confirmation email from the
 * test-only Cloudflare Email Worker (apps/mail-receiver). It is a MessageSource, so the RestrictedVerificationMailbox wrapper still enforces,
 * for this adapter exactly as for every other: approval, exact synthetic recipient, run binding, freshness, link host/path/fragment, evidence
 * minimization and sanitized errors. This adapter adds only the transport:
 *  - it talks to ONE host: the owner-approved receiver host (config.mailbox.receiverHost, which the environment must repeat exactly);
 *    never a production host, never a redirect target;
 *  - every request is signed with the retrieval key over method, path, time, a one-time nonce and the exact body;
 *  - every returned message must authenticate with the delivery key (the same envelope the local spool uses) or the whole answer is refused;
 *  - the receiver deletes what it returns in the same step (a claim is single use), so a source `consume` has nothing left to do;
 *  - no response detail, header, URL, key or message ever reaches an error: every failure is one of a few fixed sentences.
 * It makes NO request unless it is constructed (which needs the approved config and both credentials) and then asked about a recipient.
 */
const RUN_FROM_RECIPIENT = /^acc-([a-z0-9]{4,12})-[a-z0-9]{1,16}@/;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_MESSAGES = 5;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export interface ReceiverDeps {
  fetch?: FetchFn;
  now?: () => number;
  nonce?: () => string;
}

export function createReceiverSource(env: Readonly<Record<string, string | undefined>>, config: MailboxConfig | undefined, deps: ReceiverDeps = {}): MessageSource {
  const host = env[RECEIVER_HOST_ENV];
  if (!host) throw new HarnessRefusal('CONFIG_INVALID', `Missing mailbox configuration (name only): ${RECEIVER_HOST_ENV}.`);
  if (!HOST.test(host) || host !== host.toLowerCase() || isProductionHost(host)) throw new HarnessRefusal('CONFIG_INVALID', `${RECEIVER_HOST_ENV} is not an acceptable receiver host.`);
  if (!config?.receiverHost) throw new HarnessRefusal('CONFIG_INVALID', 'The receiver host is not approved in the committed configuration.');
  if (host !== config.receiverHost) throw new HarnessRefusal('CONFIG_INVALID', `${RECEIVER_HOST_ENV} does not match the approved receiver host.`);
  const retrievalKey = env[RETRIEVAL_KEY_ENV];
  if (!retrievalKey) throw new HarnessRefusal('CONFIG_INVALID', `Missing mailbox credentials (names only): ${RETRIEVAL_KEY_ENV}.`);
  if (retrievalKey.length < 32) throw new HarnessRefusal('CONFIG_INVALID', `${RETRIEVAL_KEY_ENV} must be at least 32 characters.`);
  const deliveryKey = readDeliveryKey(env);
  if (deliveryKey === retrievalKey) throw new HarnessRefusal('CONFIG_INVALID', 'The delivery key and the retrieval key must be different.');

  const doFetch: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? (() => Date.now());
  const nonce = deps.nonce ?? (() => randomBytes(16).toString('hex'));

  return {
    async listMessages({ recipient }): Promise<InboundMessage[]> {
      const runId = RUN_FROM_RECIPIENT.exec(recipient)?.[1];
      if (!runId) throw new HarnessRefusal('RECIPIENT_NOT_ALLOWED', 'Only synthetic recipients can be read.');
      const body = JSON.stringify({ runId, recipient });
      const ts = String(now());
      const n = nonce();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res: Response;
      let text: string;
      try {
        res = await doFetch(`https://${host}${CLAIM_PATH}`, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', [HEADER_TS]: ts, [HEADER_NONCE]: n, [HEADER_SIG]: signRequest(retrievalKey, { method: 'POST', path: CLAIM_PATH, ts, nonce: n, body }) },
          body,
        });
        text = await res.text();
      } catch {
        throw new HarnessRefusal('OTP_REFUSED', 'The mailbox could not be read.');
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429) return []; // "slow down": no message yet; the wrapper polls again after its own pause
      if (res.status !== 200) throw new HarnessRefusal('OTP_REFUSED', 'The mailbox refused the request.');
      if (text.length > MAX_RESPONSE_BYTES) throw new HarnessRefusal('OTP_REFUSED', 'The mailbox answer was not acceptable.');
      let parsed: { messages?: unknown };
      try {
        parsed = JSON.parse(text) as { messages?: unknown };
      } catch {
        throw new HarnessRefusal('OTP_REFUSED', 'The mailbox answer was not acceptable.');
      }
      if (!Array.isArray(parsed.messages) || parsed.messages.length > MAX_MESSAGES) throw new HarnessRefusal('OTP_REFUSED', 'The mailbox answer was not acceptable.');
      return parsed.messages.map((raw): InboundMessage => {
        const m = raw as SpoolMessage;
        if (!verifyMessage(deliveryKey, m)) throw new HarnessRefusal('OTP_REFUSED', 'A mailbox message failed authentication.');
        return { to: m.to, runId: m.runId, receivedAtMs: m.receivedAtMs, text: m.text };
      });
    },
    /** The receiver deleted the message when it returned it; there is nothing left to remove. */
    async consume(): Promise<void> {
      /* single-use claim: consumed at retrieval */
    },
  };
}
