import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HarnessRefusal } from '../guard';
import { SPOOL_FORMAT_VERSION, readDeliveryKey, signMessage, type SpoolMessage } from './spool-envelope';
import { SPOOL_ENV, assertPrivateDirectory, spoolFileName } from './local-spool';

/**
 * CASHIER-AUTH-02E E2C: the DELIVERY-BOUNDARY side of the local spool.
 *
 * Whatever receives the real confirmation email (a test-only inbound receiver, or an operator exporting one message) calls this to place it
 * where the harness reads it. It is the only thing that should hold the delivery key besides the harness, and it is deliberately small:
 *  - it accepts only a synthetic recipient `acc-<run>-<label>@<domain>` and binds the message to that run and recipient;
 *  - it writes `<sha256(recipient)>.json` with mode 0600, atomically (temporary file, then rename), refusing a symbolic link or a directory in the way;
 *  - it signs every message, keeps at most five per recipient and at most 64 KiB per file;
 *  - it never reads or lists anything else in the directory.
 * It is a library for a receiver that is not part of this change; no network listener ships here.
 */
const RECIPIENT = /^acc-([a-z0-9]{4,12})-[a-z0-9]{1,16}@[a-z0-9.-]+$/;
const MAX_TEXT = 20_000;
const MAX_PER_RECIPIENT = 5;
const MAX_FILE = 64 * 1024;

export async function deliverToSpool(input: { env: Readonly<Record<string, string | undefined>>; to: string; text: string; receivedAtMs: number }): Promise<void> {
  const dir = input.env[SPOOL_ENV];
  if (!dir || !path.isAbsolute(dir)) throw new HarnessRefusal('CONFIG_INVALID', `${SPOOL_ENV} must be an absolute path.`);
  const key = readDeliveryKey(input.env);
  assertPrivateDirectory(dir);
  const to = input.to.toLowerCase();
  const match = RECIPIENT.exec(to);
  if (!match) throw new HarnessRefusal('RECIPIENT_NOT_ALLOWED', 'Only synthetic recipients can be delivered to the spool.');
  if (typeof input.text !== 'string' || input.text.length === 0 || input.text.length > MAX_TEXT) throw new HarnessRefusal('OTP_REFUSED', 'The message could not be accepted.');
  if (!Number.isFinite(input.receivedAtMs)) throw new HarnessRefusal('OTP_REFUSED', 'The message could not be accepted.');
  const message: SpoolMessage = { to, runId: match[1] as string, receivedAtMs: input.receivedAtMs, text: input.text, mac: '' };
  message.mac = signMessage(key, message);

  const file = path.join(dir, spoolFileName(to));
  let existing: SpoolMessage[] = [];
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new HarnessRefusal('OTP_REFUSED', 'The spool entry is not a regular file.');
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { version?: unknown; messages?: unknown };
    if (parsed.version === SPOOL_FORMAT_VERSION && Array.isArray(parsed.messages)) existing = parsed.messages as SpoolMessage[];
  } catch (error) {
    if (error instanceof HarnessRefusal) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new HarnessRefusal('OTP_REFUSED', 'The spool entry could not be read.');
  }
  const body = JSON.stringify({ version: SPOOL_FORMAT_VERSION, messages: [...existing, message].slice(-MAX_PER_RECIPIENT) });
  if (Buffer.byteLength(body) > MAX_FILE) throw new HarnessRefusal('OTP_REFUSED', 'The spool entry would be too large.');
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, body, { flag: 'wx', mode: 0o600 });
  await fs.rename(tmp, file);
}
