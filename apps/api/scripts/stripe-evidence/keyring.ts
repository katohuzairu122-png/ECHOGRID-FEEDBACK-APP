/* eslint-disable no-console -- operator CLI: stdout is its output channel (JSON only; never key material) */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  CUSTODY_LOCATIONS, addKeyringEntry, assembleKeyring, completeRotation, generateKekEntry, importKek, loadKeyring, recordKekGenerated, rewrapCohort,
  verifyRemovalSafe, type CustodyLocation, type KeyringEntryJson,
} from '../../src/billing/stripe-evidence';
import { commitSha, connectGuarded, need, opt, parseArgs } from './_cli';

/**
 * HETA-01-F1 operator keyring tool. Runs OFFLINE except record-generated / rewrap, which write append-only evidence.
 * KEY MATERIAL: files are created 0600, never overwritten, and key bytes are never printed. Nothing here provisions
 * or reads a Cloudflare secret; the operator places the assembled value. Commands:
 *   generate --cohort YYYY-MM --version v1 [--inactive] --out entry.json
 *   assemble --entry a.json --entry b.json --at ISO --out keyring.json      (validates with the Worker's own loader)
 *   validate --keyring keyring.json [--at ISO]                               (prints a code only)
 *   record-generated --cohort C --version V --locations worker_secret,primary_escrow --expect-database NAME
 *   rotate-phase1 --keyring k.json --entry new.json --out k1.json            (adds the new KEK INACTIVE)
 *   rewrap --cohort C --from V1 --to V2 --old-entry old.json --new-entry new.json --expect-database NAME [--apply]
 *   rotate-phase2 --keyring k1.json --cohort C --from V1 --to V2 --at ISO --expect-database NAME --out k2.json
 */
const writeSecret = (path: string, content: string) => {
  if (existsSync(path)) throw new Error(`refusing to overwrite ${path}`);
  writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
};
const readEntry = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as KeyringEntryJson;
const atOf = (a: ReturnType<typeof parseArgs>) => new Date(opt(a, 'at') ?? new Date().toISOString());

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  switch (cmd) {
    case 'generate': {
      const entry = generateKekEntry({ cohort: need(a, 'cohort'), kekVersion: need(a, 'version'), active: !a.flags.has('inactive') });
      writeSecret(need(a, 'out'), JSON.stringify(entry, null, 2) + '\n');
      console.log(JSON.stringify({ wrote: need(a, 'out'), cohort: entry.cohort, kek_version: entry.kek_version, active: entry.active, mode: '0600' }));
      return;
    }
    case 'assemble': {
      const entries = (a.opts.get('entry') ?? []).map(readEntry);
      const json = assembleKeyring(entries);
      await loadKeyring(json, atOf(a)); // fail closed here, not in production
      writeSecret(need(a, 'out'), json);
      console.log(JSON.stringify({ wrote: need(a, 'out'), entries: entries.length, valid: true }));
      return;
    }
    case 'validate': {
      try { await loadKeyring(readFileSync(need(a, 'keyring'), 'utf8'), atOf(a)); console.log(JSON.stringify({ valid: true })); }
      catch (e) { console.log(JSON.stringify({ valid: false, code: (e as { code?: string }).code ?? 'ERR' })); process.exitCode = 2; }
      return;
    }
    case 'record-generated': {
      const locations = need(a, 'locations').split(',').map(s => s.trim()) as CustodyLocation[];
      const bad = locations.filter(l => !CUSTODY_LOCATIONS.includes(l));
      if (bad.length) throw new Error(`unknown custody location(s): ${bad.join(',')}`);
      const c = await connectGuarded(need(a, 'expect-database'));
      try {
        const inserted = await recordKekGenerated(c.db, { cohort: need(a, 'cohort'), kekVersion: need(a, 'version'), locations, actor: `operator:${process.env.USER ?? 'unknown'}`, commitSha: commitSha() ?? undefined, ...(opt(a, 'approval-ref') ? { approvalRef: opt(a, 'approval-ref')! } : {}) });
        console.log(JSON.stringify({ recorded: inserted, locations }));
      } finally { await c.close(); }
      return;
    }
    case 'rotate-phase1': {
      const out = addKeyringEntry(readFileSync(need(a, 'keyring'), 'utf8'), readEntry(need(a, 'entry')));
      await loadKeyring(out, atOf(a));
      writeSecret(need(a, 'out'), out);
      console.log(JSON.stringify({ wrote: need(a, 'out'), phase: 1, newEntryActive: false }));
      return;
    }
    case 'rewrap': {
      const c = await connectGuarded(need(a, 'expect-database'));
      try {
        const r = await rewrapCohort(c.db, {
          cohort: need(a, 'cohort'), fromVersion: need(a, 'from'), toVersion: need(a, 'to'),
          oldKek: await importKek(readEntry(need(a, 'old-entry'))), newKek: await importKek(readEntry(need(a, 'new-entry'))),
          actor: `operator:${process.env.USER ?? 'unknown'}`, commitSha: commitSha() ?? undefined, ...(opt(a, 'approval-ref') ? { approvalRef: opt(a, 'approval-ref')! } : {}), apply: a.flags.has('apply'),
        });
        console.log(JSON.stringify(r));
      } finally { await c.close(); }
      return;
    }
    case 'rotate-phase2': {
      const cohort = need(a, 'cohort'), from = need(a, 'from'), to = need(a, 'to');
      const next = completeRotation(readFileSync(need(a, 'keyring'), 'utf8'), cohort, from, to);
      const c = await connectGuarded(need(a, 'expect-database'));
      try {
        const check = await verifyRemovalSafe(c.db, { cohort, removeVersion: from, remainingKeyringJson: next, now: atOf(a) });
        if (!check.safe) { console.log(JSON.stringify({ phase: 2, safe: false, reasons: check.reasons })); process.exitCode = 2; return; }
        writeSecret(need(a, 'out'), next);
        console.log(JSON.stringify({ wrote: need(a, 'out'), phase: 2, safe: true }));
      } finally { await c.close(); }
      return;
    }
    default:
      throw new Error('unknown command; see the header of scripts/stripe-evidence/keyring.ts');
  }
}

main().catch(e => { console.error('keyring script error:', e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
