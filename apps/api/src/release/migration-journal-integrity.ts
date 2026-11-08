/**
 * Group 21 DEV-107–109: offline migration-manifest structural validation.
 * Caller-supplied journal/file names are NOT proof of migration application,
 * database compatibility, approved staging, or production release.
 * This pure boundary never connects to a database or runs migrations.
 */
export type MigrationManifestReason =
  | 'JOURNAL_INVALID'
  | 'ENTRY_INVALID'
  | 'JOURNAL_ORDER_INVALID'
  | 'JOURNAL_DUPLICATE'
  | 'SQL_FILE_MISSING'
  | 'SQL_FILE_UNJOURNALED';

export type MigrationManifestAssessment = Readonly<{
  status: 'STRUCTURALLY_CONSISTENT' | 'BLOCKED';
  reasons: readonly MigrationManifestReason[];
  journalEntries: number;
  sqlFiles: number;
  stagingVerified: false;
  migrationsAppliedVerified: false;
  mergeAuthorized: false;
  deploymentAuthorized: false;
  financialAuthorization: 'NOT_GRANTED';
}>;

const TAG = /^[0-9]{4}_[a-z0-9_]+$/;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function assessMigrationManifest(journal: unknown, names: unknown): MigrationManifestAssessment {
  const reasons = new Set<MigrationManifestReason>();
  const files = Array.isArray(names) && names.every(n => typeof n === 'string') ? names as string[] : null;
  const j = isObject(journal) ? journal : null;
  const entries = j && Array.isArray(j.entries) ? j.entries : null;

  if (!j || j.version !== '7' || j.dialect !== 'postgresql' || !entries || entries.length === 0 || !files) {
    reasons.add('JOURNAL_INVALID');
  }

  const sqlNames = files?.filter(name => name.endsWith('.sql')) ?? [];
  const tags = new Set<string>();
  let previousWhen = -1;
  if (entries) {
    for (let i = 0; i < entries.length; i++) {
      const e: unknown = entries[i];
      if (!isObject(e) || typeof e.tag !== 'string' || !TAG.test(e.tag) ||
          e.version !== '7' || e.breakpoints !== true ||
          !Number.isSafeInteger(e.idx) || !Number.isSafeInteger(e.when) ||
          (e.when as number) <= 0) {
        reasons.add('ENTRY_INVALID');
        continue;
      }
      if (e.idx !== i || !e.tag.startsWith(String(i).padStart(4, '0') + '_') ||
          (e.when as number) <= previousWhen) {
        reasons.add('JOURNAL_ORDER_INVALID');
      }
      previousWhen = e.when as number;
      if (tags.has(e.tag)) reasons.add('JOURNAL_DUPLICATE');
      tags.add(e.tag);
    }
  }

  if (files) {
    const uniqueFiles = new Set<string>();
    for (const name of sqlNames) {
      if (!/^([0-9]{4}_[a-z0-9_]+)\.sql$/.test(name) || uniqueFiles.has(name)) {
        reasons.add('SQL_FILE_UNJOURNALED');
      }
      uniqueFiles.add(name);
      if (!tags.has(name.slice(0, -4))) reasons.add('SQL_FILE_UNJOURNALED');
    }
    if (entries) {
      for (const e of entries) {
        if (isObject(e) && typeof e.tag === 'string' && !uniqueFiles.has(e.tag + '.sql')) {
          reasons.add('SQL_FILE_MISSING');
        }
      }
    }
  }

  const problems = [...reasons].sort();
  return Object.freeze({
    status: problems.length ? 'BLOCKED' as const : 'STRUCTURALLY_CONSISTENT' as const,
    reasons: Object.freeze(problems),
    journalEntries: entries?.length ?? 0,
    sqlFiles: sqlNames.length,
    stagingVerified: false as const,
    migrationsAppliedVerified: false as const,
    mergeAuthorized: false as const,
    deploymentAuthorized: false as const,
    financialAuthorization: 'NOT_GRANTED' as const,
  });
}
