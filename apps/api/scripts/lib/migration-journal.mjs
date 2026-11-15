/**
 * MIGRATION-GOV-01 C4: the ONE place Gate 2 scripts, workflows and release tests learn how many migrations the repository
 * has and which one is last. Before this module each of ~20 files hard-coded the count and the final tag, so adding a
 * migration failed every Gate 2 job until each pin was edited by hand (it happened for 0071 and again for 0072).
 *
 * Source of truth: the COMMITTED Drizzle journal (`git show HEAD:apps/api/drizzle/meta/_journal.json`), NOT the working
 * tree. The prefix-upgrade gate deliberately truncates the working-tree journal to 45 entries mid-run; reading the
 * committed copy keeps the full expectation stable while it does. Outside a git checkout it falls back to the file.
 *
 * Fixed historical anchors that must NEVER move with new migrations (entry 44 and 45 tags, the 45-entry staging prefix)
 * live here as named constants so no script spells them out.
 *
 * CLI (used by workflows):  node scripts/lib/migration-journal.mjs count | last-index | last-tag | pending-range
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const journalUrl = new URL('../../drizzle/meta/_journal.json', import.meta.url);
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** Historical anchors of the staging prefix (the first 45 migrations were applied to staging before Gate 2). */
export const PREFIX_COUNT = 45;
export const PREFIX_LAST_TAG = '0044_split07_multiunit_inert_conservation';
export const PREFIX_FIRST_PENDING_TAG = '0045_heta01_f1_stripe_evidence';

function readCommittedJournal() {
  try {
    return JSON.parse(
      execFileSync('git', ['show', 'HEAD:apps/api/drizzle/meta/_journal.json'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return JSON.parse(readFileSync(journalUrl, 'utf8'));
  }
}

export const journal = readCommittedJournal();

const entries = journal.entries;
if (
  journal.version !== '7' ||
  journal.dialect !== 'postgresql' ||
  !Array.isArray(entries) ||
  entries.length <= PREFIX_COUNT ||
  entries.some((e, i) => e.idx !== i || !e.tag.startsWith(String(i).padStart(4, '0') + '_')) ||
  entries[PREFIX_COUNT - 1].tag !== PREFIX_LAST_TAG ||
  entries[PREFIX_COUNT].tag !== PREFIX_FIRST_PENDING_TAG
) {
  throw new Error('MIGRATION_JOURNAL_UNEXPECTED');
}

/** Total migrations the repository defines (what a full replay must have applied). */
export const MIGRATION_COUNT = entries.length;
export const LAST_MIGRATION_INDEX = entries.length - 1;
export const LAST_MIGRATION_TAG = entries[entries.length - 1].tag;
export const JOURNAL_ENTRIES = entries;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const what = process.argv[2];
  const out = {
    count: MIGRATION_COUNT,
    'last-index': LAST_MIGRATION_INDEX,
    'last-tag': LAST_MIGRATION_TAG,
    'pending-range': `${PREFIX_COUNT} through ${LAST_MIGRATION_INDEX}`,
  }[what];
  if (out === undefined) {
    console.error('usage: migration-journal.mjs count | last-index | last-tag | pending-range');
    process.exit(2);
  }
  console.log(out);
}
