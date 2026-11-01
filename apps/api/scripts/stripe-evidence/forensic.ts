/* eslint-disable no-console -- operator CLI: stdout is its output channel (JSON only; plaintext only with --stdout) */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ForensicReader, listEventRecords, loadKeyring } from '../../src/billing/stripe-evidence';
import { forensicFiles, safeOutputError } from './_secure-output';
import { connectGuarded, need, opt, parseArgs } from './_cli';

/**
 * HETA-01-F1 forensic reader (operator only; custodians named per H9). Every decrypting command is audited BEFORE any
 * plaintext is produced (fail closed). By default plaintext is NOT printed: `read-event` reports verification only; use
 * `export-event` to write a registered 0600 file (destroy it with `destroy-export`), or `--stdout` deliberately.
 *   list --account acct_... --event evt_...                       (no decryption)
 *   read-event --id <uuid> --actor NAME --reason TEXT [--approval-ref REF] [--stdout]
 *   export-event --id <uuid> --out FILE --location-label LABEL --actor NAME --reason TEXT
 *   destroy-export --path FILE --label <exportLabel> --actor NAME --reason TEXT
 * Keyring: EVIDENCE_KEK_KEYRING_FILE (the operator forensic environment's copy). All commands need --expect-database.
 */
async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  const conn = await connectGuarded(need(a, 'expect-database'));
  try {
    if (cmd === 'list') {
      console.log(JSON.stringify(await listEventRecords(conn.db, need(a, 'account'), need(a, 'event')), null, 2));
      return;
    }
    const file = process.env.EVIDENCE_KEK_KEYRING_FILE;
    if (!file) throw new Error('EVIDENCE_KEK_KEYRING_FILE is required');
    // Forensic environments may hold older cohorts only: validate against a window that always contains the evaluation instant.
    const reader = new ForensicReader(conn.db, await loadKeyring(readFileSync(file, 'utf8'), new Date()).catch(() => { throw new Error('keyring invalid for the current time'); }), forensicFiles);
    const ctx = { actor: need(a, 'actor'), reason: need(a, 'reason'), approvalRef: opt(a, 'approval-ref') };
    if (cmd === 'read-event') {
      const bytes = await reader.readEvent(need(a, 'id'), ctx);
      if (a.flags.has('stdout')) process.stdout.write(Buffer.from(bytes));
      else console.log(JSON.stringify({ verified: true, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
    } else if (cmd === 'export-event') {
      console.log(JSON.stringify(await reader.exportEventToFile(need(a, 'id'), ctx, need(a, 'out'), need(a, 'location-label'))));
    } else if (cmd === 'destroy-export') {
      await reader.destroyExport(need(a, 'path'), need(a, 'label'), ctx);
      console.log(JSON.stringify({ destroyed: true }));
    } else {
      throw new Error('unknown command; see the header of scripts/stripe-evidence/forensic.ts');
    }
  } finally {
    await conn.close();
  }
}

main().catch(e => { console.error(JSON.stringify({ error: 'forensic operation failed', ...safeOutputError(e) })); process.exitCode = 1; });
