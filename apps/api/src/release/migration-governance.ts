/**
 * MIGRATION-GOV-01 C4: pure guard that finds hard-coded migration pins (the current migration count, the last journal index
 * or the last migration tag spelled out in a Gate 2 script, workflow or release test). Pure: it reads nothing and applies
 * nothing; the caller supplies the text. Hard-coded pins are what broke ~20 Gate 2 files each time a migration was added.
 */
export type MigrationPinFinding = Readonly<{ line: number; kind: 'COUNT' | 'LAST_INDEX' | 'LAST_TAG' | 'MISSING_SHARED_MODULE'; text: string }>;

export function findHardCodedMigrationPins(
  source: string,
  facts: Readonly<{ count: number; lastTag: string }>,
  options: Readonly<{ requireSharedModule?: boolean }> = {},
): readonly MigrationPinFinding[] {
  const findings: MigrationPinFinding[] = [];
  const lastIndex = facts.count - 1;
  const lines = source.split(/\r?\n/);
  lines.forEach((text, i) => {
    const line = i + 1;
    if (text.includes(facts.lastTag)) findings.push({ line, kind: 'LAST_TAG', text: text.trim() });
    // A number is a pin only on a line that talks about migrations/journal entries, so ports, versions and PG majors do not trip it.
    if (/migrat|journal|entries/i.test(text)) {
      for (const m of text.matchAll(/(?<![\w.:-])(\d{2,3})(?![\w.:-])/g)) {
        const n = Number(m[1]);
        if (n === facts.count) findings.push({ line, kind: 'COUNT', text: text.trim() });
        else if (n === lastIndex && /\[\s*\d+\s*\]|entries|index/i.test(text)) findings.push({ line, kind: 'LAST_INDEX', text: text.trim() });
      }
    }
    if (new RegExp(`entries\\[${lastIndex}\\]`).test(text)) findings.push({ line, kind: 'LAST_INDEX', text: text.trim() });
  });
  if (options.requireSharedModule && /__drizzle_migrations/.test(source) && !/migration-journal/.test(source)) {
    findings.push({ line: 0, kind: 'MISSING_SHARED_MODULE', text: 'queries __drizzle_migrations without scripts/lib/migration-journal.mjs' });
  }
  return findings;
}
