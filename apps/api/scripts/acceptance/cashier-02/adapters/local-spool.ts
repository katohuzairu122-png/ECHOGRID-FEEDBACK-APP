import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HarnessRefusal } from '../guard';
import type { InboundMessage, MessageSource } from '../verification-mailbox';

/**
 * CASHIER-AUTH-02E E2-B: the provider-neutral, locally testable mailbox adapter ("local-spool").
 *
 * No external provider is approved for reading test mail, so this adapter reads NO provider at all: it reads one small JSON file per
 * recipient from an operator-controlled directory (`ACCEPTANCE_MAILBOX_SPOOL_DIR`). It is how local tests and an authorised operator who
 * exports a message out of band supply the confirmation link, and the shape any future provider adapter must produce.
 *
 * Restrictions (on top of everything the RestrictedVerificationMailbox enforces for every adapter):
 *  - it opens ONLY `<sha256(recipient)>.json` inside the directory: it never lists the directory, never globs, never follows a symbolic link out of it;
 *  - the directory must already exist and be absolute; the file must be a regular file of at most 64 KiB;
 *  - a malformed file is an error that names no content; a missing file is simply "no message yet".
 * Adding a provider adapter means adding another entry beside this one, never widening this one.
 */
export const SPOOL_ENV = 'ACCEPTANCE_MAILBOX_SPOOL_DIR';
const MAX_FILE = 64 * 1024;

export const spoolFileName = (recipient: string): string => `${createHash('sha256').update(recipient.toLowerCase()).digest('hex')}.json`;

export function createLocalSpoolSource(env: Readonly<Record<string, string | undefined>>): MessageSource {
  const dir = env[SPOOL_ENV];
  if (!dir) throw new HarnessRefusal('CONFIG_INVALID', `Missing mailbox configuration (name only): ${SPOOL_ENV}.`);
  if (!path.isAbsolute(dir)) throw new HarnessRefusal('CONFIG_INVALID', `${SPOOL_ENV} must be an absolute path.`);
  return {
    async listMessages({ recipient }) {
      const file = path.join(dir, spoolFileName(recipient));
      let real: string;
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size > MAX_FILE) throw new HarnessRefusal('OTP_REFUSED', 'The mailbox file is not acceptable.');
        real = await fs.realpath(file);
      } catch (error) {
        if (error instanceof HarnessRefusal) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw new HarnessRefusal('OTP_REFUSED', 'The mailbox file could not be read.');
      }
      if (path.dirname(real) !== (await fs.realpath(dir))) throw new HarnessRefusal('OTP_REFUSED', 'The mailbox file is outside the mailbox directory.');
      let parsed: unknown;
      try {
        parsed = JSON.parse(await fs.readFile(real, 'utf8'));
      } catch {
        throw new HarnessRefusal('OTP_REFUSED', 'The mailbox file is not valid.');
      }
      const list = (parsed as { messages?: unknown })?.messages;
      if (!Array.isArray(list)) throw new HarnessRefusal('OTP_REFUSED', 'The mailbox file is not valid.');
      return list.map((m): InboundMessage => {
        const r = m as Partial<InboundMessage>;
        return { to: typeof r.to === 'string' ? r.to : '', receivedAtMs: typeof r.receivedAtMs === 'number' ? r.receivedAtMs : Number.NaN, text: typeof r.text === 'string' ? r.text : '' };
      });
    },
  };
}
