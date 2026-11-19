import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { HarnessRefusal } from '../guard';

/**
 * CASHIER-AUTH-02E E2C: the authenticated envelope of a spool message.
 *
 * A file name proves nothing: anyone who can write the spool directory could place a message there. So every message carries a MAC made with a
 * delivery key that only the delivery boundary (whatever receives the real email) and the harness know. The MAC binds the exact recipient,
 * the run, the arrival time and the message text. A message that fails it is refused, never ignored: it is evidence of tampering or injection.
 * The key is supplied through the environment (name only in documents), is at least 32 characters, and never appears in an error or a result.
 */
export const DELIVERY_KEY_ENV = 'ACCEPTANCE_MAILBOX_DELIVERY_KEY';
export const SPOOL_FORMAT_VERSION = 1;
const MIN_KEY = 32;

export interface SpoolMessage {
  to: string;
  runId: string;
  receivedAtMs: number;
  text: string;
  mac: string;
}

export function readDeliveryKey(env: Readonly<Record<string, string | undefined>>): string {
  const key = env[DELIVERY_KEY_ENV];
  if (!key) throw new HarnessRefusal('CONFIG_INVALID', `Missing mailbox configuration (name only): ${DELIVERY_KEY_ENV}.`);
  if (key.length < MIN_KEY) throw new HarnessRefusal('CONFIG_INVALID', `${DELIVERY_KEY_ENV} must be at least ${MIN_KEY} characters.`);
  return key;
}

const canonical = (m: Pick<SpoolMessage, 'to' | 'runId' | 'receivedAtMs' | 'text'>): string =>
  ['v1', m.to.toLowerCase(), m.runId, String(m.receivedAtMs), createHash('sha256').update(m.text).digest('hex')].join('\n');

export const signMessage = (key: string, m: Pick<SpoolMessage, 'to' | 'runId' | 'receivedAtMs' | 'text'>): string =>
  createHmac('sha256', key).update(canonical(m)).digest('hex');

export function verifyMessage(key: string, m: SpoolMessage): boolean {
  if (typeof m.mac !== 'string' || !/^[0-9a-f]{64}$/.test(m.mac)) return false;
  if (typeof m.to !== 'string' || typeof m.runId !== 'string' || typeof m.text !== 'string' || typeof m.receivedAtMs !== 'number' || !Number.isFinite(m.receivedAtMs)) return false;
  const expected = Buffer.from(signMessage(key, m), 'hex');
  const given = Buffer.from(m.mac, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
