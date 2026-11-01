import { execSync } from 'node:child_process';
import { Client } from 'pg';
import { buildDb, type Database } from '../../src/db/client';

/** Tiny argv parser: `--flag`, `--key value`, repeated keys collect. No dependencies. */
export function parseArgs(argv: string[]): { _: string[]; flags: Set<string>; opts: Map<string, string[]> } {
  const out = { _: [] as string[], flags: new Set<string>(), opts: new Map<string, string[]>() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out.flags.add(k);
    else { out.opts.set(k, [...(out.opts.get(k) ?? []), next]); i++; }
  }
  return out;
}

export const opt = (a: ReturnType<typeof parseArgs>, k: string): string | undefined => a.opts.get(k)?.[0];
export const need = (a: ReturnType<typeof parseArgs>, k: string): string => {
  const v = opt(a, k);
  if (!v) throw new Error(`missing required --${k}`);
  return v;
};

export function commitSha(): string | null {
  if (process.env.COMMIT_SHA) return process.env.COMMIT_SHA;
  try { return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; }
}

/**
 * Connects to DATABASE_URL and REFUSES to continue unless the connected database name equals --expect-database.
 * Operator scripts write append-only evidence; a wrong target cannot be undone.
 */
export async function connectGuarded(expectDatabase: string): Promise<{ db: Database; close: () => Promise<void>; name: string }> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const name = (await c.query('select current_database() as n')).rows[0].n as string;
  if (name !== expectDatabase) {
    await c.end();
    throw Object.assign(new Error('refusing: connected database does not match the expected database'), { code: 'DATABASE_MISMATCH' });
  }
  return { db: buildDb(c), close: () => c.end(), name };
}
