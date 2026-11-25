/**
 * Builds the DRAFT Community legal bundle manifest from docs/legal/community/drafts/community-terms.<locale>.md.
 *   node scripts/community-legal-bundle.mjs           -> writes BUNDLE.draft.json
 *   node scripts/community-legal-bundle.mjs --check   -> exits 1 if the committed manifest differs from the files
 * Content hash = SHA-256 over the UTF-8 bytes of the file, the same function the Community terms authority uses (hashCommunityTermsContent).
 * This is NOT a publication: no id, no dates, no approval, nothing is seeded. manifestHash is deliberately absent until a real publication id and dates exist.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/legal/community/drafts');
const LOCALES = ['en', 'fr', 'es', 'ar'];
const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

export function buildBundle() {
  return {
    status: 'DRAFT — NOT LEGALLY APPROVED',
    purpose: 'community_membership',
    canonicalLocale: 'en',
    hashAlgorithm: 'sha256-utf8',
    publication: { id: null, version: null, publishedAt: null, effectiveAt: null, approval: null, manifestHash: null },
    artifacts: LOCALES.map((locale) => {
      const content = readFileSync(join(dir, `community-terms.${locale}.md`), 'utf8');
      return { locale, file: `community-terms.${locale}.md`, bytes: Buffer.byteLength(content, 'utf8'), contentHash: sha256(content) };
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = join(dir, 'BUNDLE.draft.json');
  const next = JSON.stringify(buildBundle(), null, 2) + '\n';
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(file, 'utf8'); } catch { /* missing */ }
    if (current !== next) { console.error('DRIFT: BUNDLE.draft.json'); process.exit(1); }
    console.log('bundle manifest matches the draft files');
  } else {
    writeFileSync(file, next);
    console.log('wrote BUNDLE.draft.json');
  }
}
