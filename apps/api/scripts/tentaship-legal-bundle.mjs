/**
 * Builds the DRAFT Tentaship legal bundle manifest from docs/legal/tentaship/drafts/<document>.<locale>.md (same method as community-legal-bundle.mjs).
 *   node scripts/tentaship-legal-bundle.mjs           -> writes BUNDLE.draft.json
 *   node scripts/tentaship-legal-bundle.mjs --check   -> exits 1 if the committed manifest differs from the files
 * Content hash = SHA-256 over the UTF-8 bytes of the file. This is NOT a publication and NOT an approval: every publication/approval field is null.
 * Register items L-1..L-6 are listed per document; nothing here resolves them.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/legal/tentaship/drafts');
export const LOCALES = ['en', 'fr', 'es', 'ar'];
export const DOCUMENTS = {
  'tentaship-participation-terms': ['L-1', 'L-2', 'L-3', 'L-4'], 'tentaship-privacy-supplement': ['L-5'], 'tentaship-marketing-consent': ['L-5'],
  'tentaship-sponsor-terms': ['L-3', 'L-6'], 'tentaship-free-route-statement': ['L-2', 'L-4'],
};
const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

export function buildBundle() {
  return {
    status: 'DRAFT — NOT LEGALLY APPROVED — NOT FOR PUBLICATION', canonicalLocale: 'en', hashAlgorithm: 'sha256-utf8',
    publication: { id: null, version: null, publishedAt: null, effectiveAt: null, approval: null, manifestHash: null },
    translationApproval: { en: null, fr: null, es: null, ar: null },
    documents: Object.entries(DOCUMENTS).map(([name, registerItems]) => ({
      name, registerItems,
      artifacts: LOCALES.map((locale) => { const content = readFileSync(join(dir, `${name}.${locale}.md`), 'utf8'); return { locale, file: `${name}.${locale}.md`, bytes: Buffer.byteLength(content, 'utf8'), contentHash: sha256(content) }; }),
    })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = join(dir, 'BUNDLE.draft.json');
  const next = JSON.stringify(buildBundle(), null, 2) + '\n';
  if (process.argv.includes('--check')) {
    let current = ''; try { current = readFileSync(file, 'utf8'); } catch { /* missing */ }
    if (current !== next) { console.error('DRIFT: BUNDLE.draft.json'); process.exit(1); }
    console.log('bundle manifest matches the draft files');
  } else { writeFileSync(file, next); console.log('wrote BUNDLE.draft.json'); }
}
