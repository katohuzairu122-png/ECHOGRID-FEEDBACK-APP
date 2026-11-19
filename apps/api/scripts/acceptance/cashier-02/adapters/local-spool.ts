import { createHash } from 'node:crypto';
import { statSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { HarnessRefusal } from '../guard';
import type { InboundMessage, MessageSource } from '../verification-mailbox';
import { SPOOL_FORMAT_VERSION, readDeliveryKey, verifyMessage, type SpoolMessage } from './spool-envelope';

/**
 * CASHIER-AUTH-02E E2-B/E2C: the provider-neutral, locally testable mailbox adapter ("local-spool").
 *
 * No external provider is approved for reading test mail, so this adapter reads NO provider at all: it reads one small JSON file per
 * recipient from an operator-controlled directory (`ACCEPTANCE_MAILBOX_SPOOL_DIR`) that a delivery boundary fills (see local-spool-writer.ts).
 *
 * Restrictions (on top of everything the RestrictedVerificationMailbox enforces for every adapter):
 *  - it opens ONLY `<sha256(recipient)>.json` inside the directory: it never lists the directory, never globs, never follows a symbolic link out of it;
 *  - the directory must already exist, be absolute and NOT be readable or writable by group or others (mode 0700 style);
 *  - the file must be a regular file of at most 64 KiB, in the current format version;
 *  - EVERY message must authenticate with the delivery key (HMAC over recipient, run, arrival time and text) or the file is refused;
 *  - a missing file is "no message yet"; a malformed file is an error that names no content;
 *  - after a verification has been used, `consume` removes that one file: the message holds a one-time proof and does not stay on disk.
 * Adding a provider adapter means adding another entry beside this one, never widening this one.
 */
export const SPOOL_ENV = 'ACCEPTANCE_MAILBOX_SPOOL_DIR';
const MAX_FILE = 64 * 1024;

export const spoolFileName = (recipient: string): string => `${createHash('sha256').update(recipient.toLowerCase()).digest('hex')}.json`;

/** The directory must be private to its owner: a group- or world-accessible spool is a place where messages can be read or injected. */
export function assertPrivateDirectory(dir: string): void {
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    throw new HarnessRefusal('CONFIG_INVALID', `${SPOOL_ENV} must name an existing directory.`);
  }
  if (!stat.isDirectory()) throw new HarnessRefusal('CONFIG_INVALID', `${SPOOL_ENV} must name a directory.`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new HarnessRefusal('CONFIG_INVALID', `${SPOOL_ENV} must not be accessible to group or others (use mode 0700).`);
  }
}

async function resolveFile(dir: string, recipient: string): Promise<string | null> {
  const file = path.join(dir, spoolFileName(recipient));
  let real: string;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_FILE) throw new HarnessRefusal('OTP_REFUSED', 'The mailbox file is not acceptable.');
    real = await fs.realpath(file);
  } catch (error) {
    if (error instanceof HarnessRefusal) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new HarnessRefusal('OTP_REFUSED', 'The mailbox file could not be read.');
  }
  if (path.dirname(real) !== (await fs.realpath(dir))) throw new HarnessRefusal('OTP_REFUSED', 'The mailbox file is outside the mailbox directory.');
  return real;
}

export function createLocalSpoolSource(env: Readonly<Record<string, string | undefined>>): MessageSource {
  const dir = env[SPOOL_ENV];
  if (!dir) throw new HarnessRefusal('CONFIG_INVALID', `Missing mailbox configuration (name only): ${SPOOL_ENV}.`);
  if (!path.isAbsolute(dir)) throw new HarnessRefusal('CONFIG_INVALID', `${SPOOL_ENV} must be an absolute path.`);
  const key = readDeliveryKey(env);
  assertPrivateDirectory(dir);
  return {
    async listMessages({ recipient }) {
      const real = await resolveFile(dir, recipient);
      if (real === null) return [];
      let parsed: { version?: unknown; messages?: unknown };
      try {
        parsed = JSON.parse(await fs.readFile(real, 'utf8')) as typeof parsed;
      } catch {
        throw new HarnessRefusal('OTP_REFUSED', 'The mailbox file is not valid.');
      }
      if (parsed.version !== SPOOL_FORMAT_VERSION || !Array.isArray(parsed.messages)) throw new HarnessRefusal('OTP_REFUSED', 'The mailbox file is not valid.');
      return parsed.messages.map((raw): InboundMessage => {
        const m = raw as SpoolMessage;
        if (!verifyMessage(key, m)) throw new HarnessRefusal('OTP_REFUSED', 'A mailbox message failed authentication.');
        return { to: m.to, runId: m.runId, receivedAtMs: m.receivedAtMs, text: m.text };
      });
    },
    async consume(recipient) {
      const real = await resolveFile(dir, recipient);
      if (real !== null) await fs.unlink(real);
    },
  };
}
