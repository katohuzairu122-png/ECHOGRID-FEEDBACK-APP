import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { assessMigrationManifest } from './migration-journal-integrity';

const dir = resolve(__dirname, '../../drizzle');
const journal = JSON.parse(readFileSync(resolve(dir, 'meta/_journal.json'), 'utf8')) as {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};
const sqlFiles = readdirSync(dir).filter(name => name.endsWith('.sql'));

function assessed(j: unknown = journal, files: unknown = sqlFiles) {
  return assessMigrationManifest(j, files);
}

describe('Group 21 DEV-107–109 offline migration manifest readiness', () => {
  it('DEV-107 checks the actual committed journal and SQL file set, without applying migrations', () => {
    const result = assessed();
    expect(result).toMatchObject({
      status: 'STRUCTURALLY_CONSISTENT',
      reasons: [],
      journalEntries: journal.entries.length,
      sqlFiles: journal.entries.length,
      stagingVerified: false,
      migrationsAppliedVerified: false,
      mergeAuthorized: false,
      deploymentAuthorized: false,
      financialAuthorization: 'NOT_GRANTED',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reasons)).toBe(true);
  });

  it.each([
    null, {}, [], { ...journal, dialect: 'sqlite' },
    { ...journal, version: '6' }, { ...journal, entries: [] },
  ])('DEV-107 rejects invalid migration journal %#', bad => {
    expect(assessed(bad).status).toBe('BLOCKED');
    expect(assessed(bad).reasons).toContain('JOURNAL_INVALID');
  });

  it('DEV-108 rejects absent or unjournaled SQL files without fetching a database', () => {
    const missing = assessed(journal, sqlFiles.slice(1));
    expect(missing.reasons).toContain('SQL_FILE_MISSING');
    const extra = assessed(journal, [...sqlFiles, '0067_unapproved.sql']);
    expect(extra.reasons).toContain('SQL_FILE_UNJOURNALED');
    const duplicate = assessed(journal, [...sqlFiles, sqlFiles[0]]);
    expect(duplicate.reasons).toContain('SQL_FILE_UNJOURNALED');
  });

  it('DEV-108 rejects reordered, duplicated and traversal-capable journal entries', () => {
    const first = journal.entries[0]!;
    const second = journal.entries[1]!;
    expect(assessed({ ...journal, entries: [{ ...first, idx: 1 }, ...journal.entries.slice(1)] }).reasons)
      .toContain('JOURNAL_ORDER_INVALID');
    expect(assessed({ ...journal, entries: [second, first, ...journal.entries.slice(2)] }).reasons)
      .toContain('JOURNAL_ORDER_INVALID');
    expect(assessed({ ...journal, entries: [{ ...first, tag: '../secret' }, ...journal.entries.slice(1)] }).reasons)
      .toContain('ENTRY_INVALID');
    expect(assessed({ ...journal, entries: [first, { ...second, tag: first.tag }, ...journal.entries.slice(2)] }).reasons)
      .toContain('JOURNAL_DUPLICATE');
  });

  it('DEV-109 refuses invalid timestamps and missing breakpoints', () => {
    const first = journal.entries[0]!;
    for (const entry of [
      { ...first, when: Number.NaN },
      { ...first, when: 0 },
      { ...first, breakpoints: false },
      { ...first, version: '6' },
    ]) {
      expect(assessed({ ...journal, entries: [entry, ...journal.entries.slice(1)] }).reasons)
        .toContain('ENTRY_INVALID');
    }
  });

  it('DEV-109 never promotes caller claims or migration inventory to release authorization', () => {
    const candidate = { ...journal, stagingVerified: true, migrationAuthorized: true, deploymentAuthorized: true };
    const result = assessed(candidate);
    expect(result.status).toBe('STRUCTURALLY_CONSISTENT');
    expect(result.stagingVerified).toBe(false);
    expect(result.migrationsAppliedVerified).toBe(false);
    expect(result.deploymentAuthorized).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
