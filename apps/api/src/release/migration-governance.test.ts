import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { findHardCodedMigrationPins } from './migration-governance';
import { assessMigrationManifest } from './migration-journal-integrity';

/**
 * MIGRATION-GOV-01 C4. Adding migration NNNN must require touching ONLY drizzle/ (SQL, snapshot, journal). Every Gate 2
 * script, workflow and release test learns the count and the last tag from the journal through one shared module. This
 * suite fails if anyone pins them again.
 */
const api = resolve(__dirname, '../..');
const repo = resolve(api, '../..');
const journalPath = resolve(api, 'drizzle/meta/_journal.json');
const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
const facts = { count: journal.entries.length, lastTag: journal.entries.at(-1)!.tag };
const cli = (what: string) => execFileSync('node', [resolve(api, 'scripts/lib/migration-journal.mjs'), what], { encoding: 'utf8' }).trim();

const read = (p: string) => readFileSync(p, 'utf8');
const gateScripts = readdirSync(join(api, 'scripts'))
  .filter((f) => /^(gate2-|verify-gate2-).*\.mjs$/.test(f))
  .map((f) => join(api, 'scripts', f));
const gateWorkflows = readdirSync(join(repo, '.github/workflows'))
  .filter((f) => /^gate2-.*\.yml$/.test(f))
  .map((f) => join(repo, '.github/workflows', f));
const releaseFiles = readdirSync(join(api, 'src/release'))
  .filter((f) => /\.(ts)$/.test(f) && !/^migration-governance/.test(f))
  .map((f) => join(api, 'src/release', f));

describe('shared migration journal module', () => {
  it('reports exactly what the committed journal says', () => {
    expect(cli('count')).toBe(String(facts.count));
    expect(cli('last-index')).toBe(String(facts.count - 1));
    expect(cli('last-tag')).toBe(facts.lastTag);
    expect(cli('pending-range')).toBe(`45 through ${facts.count - 1}`);
  });
  it('rejects an unknown query instead of guessing', () => {
    expect(() => execFileSync('node', [resolve(api, 'scripts/lib/migration-journal.mjs'), 'nonsense'], { stdio: 'pipe' })).toThrow();
  });
  it('the committed journal and SQL files are structurally consistent (existing manifest checker)', () => {
    const dir = resolve(api, 'drizzle');
    const names = readdirSync(dir).filter((n) => n.endsWith('.sql'));
    expect(assessMigrationManifest(JSON.parse(read(journalPath)), names)).toMatchObject({ status: 'STRUCTURALLY_CONSISTENT', reasons: [] });
  });
  it('every journal entry from 0033 on has a Drizzle snapshot (0029-0032 are historical gaps; the next generate/check needs the latest)', () => {
    const snaps = new Set(readdirSync(resolve(api, 'drizzle/meta')));
    for (const e of journal.entries.filter((x) => x.idx >= 33)) expect(snaps.has(`${String(e.idx).padStart(4, '0')}_snapshot.json`), e.tag).toBe(true);
  });
});

describe('no hard-coded migration pins (the guard itself)', () => {
  const facts2 = { count: 73, lastTag: '0072_customer_verified_login_email' };
  it('flags the count, the last index and the last tag, and ignores ports, versions and unrelated numbers', () => {
    const kinds = (s: string) => findHardCodedMigrationPins(s, facts2).map((f) => f.kind);
    expect(kinds("assert.equal(rows[0].n, 73); // migrations")).toEqual(['COUNT']);
    expect(kinds("check(history.n===73,'MIGRATIONS_NOT_REPLAYED')")).toEqual(['COUNT']);
    expect(kinds("journal.entries[72].tag !== 'x'")).toContain('LAST_INDEX');
    expect(kinds("tag === '0072_customer_verified_login_email'")).toEqual(['LAST_TAG']);
    expect(kinds("localhost:5432 postgres 18 timeout 73000 migrations")).toEqual([]);
    expect(kinds("const port = 73; // unrelated")).toEqual([]);
    // Identifiers and ranges are not counts: DEV-73, "DEV-71\u201373" (en dash) and a range with a hyphen.
    expect(kinds('describe("DEV-71\u201373 offline migration manifest")')).toEqual([]);
    expect(kinds('it("DEV-73 rejects a bad journal")')).toEqual([]);
    expect(kinds('// migrations 70-73')).toEqual([]);
  });
  it('flags a script that queries __drizzle_migrations without the shared module, accepts one that imports it', () => {
    const q = "await c.query('SELECT count(*) FROM drizzle.__drizzle_migrations')";
    expect(findHardCodedMigrationPins(q, facts2, { requireSharedModule: true }).map((f) => f.kind)).toEqual(['MISSING_SHARED_MODULE']);
    expect(findHardCodedMigrationPins(`import { MIGRATION_COUNT } from './lib/migration-journal.mjs';\n${q}`, facts2, { requireSharedModule: true })).toEqual([]);
  });
});

describe('repository files carry no hard-coded migration pins', () => {
  it.each(gateScripts.map((p) => [p.replace(repo + '/', ''), p]))('%s', (_n, p) => {
    expect(findHardCodedMigrationPins(read(p), facts, { requireSharedModule: true })).toEqual([]);
  });
  it.each(gateWorkflows.map((p) => [p.replace(repo + '/', ''), p]))('%s', (_n, p) => {
    expect(findHardCodedMigrationPins(read(p), facts)).toEqual([]);
  });
  it.each(releaseFiles.map((p) => [p.replace(repo + '/', ''), p]))('%s', (_n, p) => {
    expect(findHardCodedMigrationPins(read(p), facts)).toEqual([]);
  });
  it('covers the files that broke before (guards against the lists silently becoming empty)', () => {
    expect(gateScripts.length).toBeGreaterThan(15);
    expect(gateWorkflows.length).toBeGreaterThan(10);
    expect(releaseFiles.length).toBeGreaterThan(3);
  });
});
