import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

/** Guards the DRAFT Community legal artifacts: four languages stay structurally identical, stay labelled unapproved, and the committed hash manifest cannot drift. */
const dir = resolve(__dirname, '../../../../docs/legal/community/drafts');
const LOCALES = ['en', 'fr', 'es', 'ar'] as const;
const read = (locale: string) => readFileSync(resolve(dir, `community-terms.${locale}.md`), 'utf8');
const clauseIds = (text: string) => [...text.matchAll(/^([A-G][0-9]+)\. /gm)].map((m) => m[1]);
const tokens = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[0]).sort();

describe('Community legal drafts (DRAFT — NOT LEGALLY APPROVED)', () => {
  const en = read('en');

  it('has the same clause identifiers, in the same order, in all four languages', () => {
    expect(clauseIds(en).length).toBeGreaterThanOrEqual(25);
    for (const locale of LOCALES) expect(clauseIds(read(locale)), locale).toEqual(clauseIds(en));
  });

  it('keeps the same placeholders and the same open legal-decision markers in every language', () => {
    for (const locale of LOCALES) {
      const text = read(locale);
      expect(tokens(text, /\{(version|effectiveDate)\}/g), locale + ' placeholders').toEqual(tokens(en, /\{(version|effectiveDate)\}/g));
      expect(tokens(text, /\[\[LEGAL-DECISION D[0-9]+:[^\]]*\]\]/g), locale + ' decisions').toEqual(tokens(en, /\[\[LEGAL-DECISION D[0-9]+:[^\]]*\]\]/g));
    }
    expect(tokens(en, /\[\[LEGAL-DECISION D[0-9]+/g).length).toBe(5);
  });

  it('is labelled as an unapproved draft in every language and never claims approval', () => {
    expect(read('en').startsWith('DRAFT — NOT LEGALLY APPROVED')).toBe(true);
    expect(read('fr').startsWith('BROUILLON — NON APPROUVÉ JURIDIQUEMENT')).toBe(true);
    expect(read('es').startsWith('BORRADOR — SIN APROBACIÓN LEGAL')).toBe(true);
    expect(read('ar').startsWith('مسودة — غير معتمدة قانونيًا')).toBe(true);
    const bundle = JSON.parse(readFileSync(resolve(dir, 'BUNDLE.draft.json'), 'utf8'));
    expect(bundle.status).toBe('DRAFT — NOT LEGALLY APPROVED');
    expect(bundle.publication).toEqual({ id: null, version: null, publishedAt: null, effectiveAt: null, approval: null, manifestHash: null });
  });

  it('commits a manifest whose SHA-256 content hashes equal the files (drift guard)', () => {
    const bundle = JSON.parse(readFileSync(resolve(dir, 'BUNDLE.draft.json'), 'utf8')) as { artifacts: { locale: string; contentHash: string; bytes: number }[] };
    expect(bundle.artifacts.map((a) => a.locale)).toEqual([...LOCALES]);
    for (const artifact of bundle.artifacts) {
      const content = read(artifact.locale);
      expect(artifact.contentHash).toBe(createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex'));
      expect(artifact.bytes).toBe(Buffer.byteLength(content, 'utf8'));
    }
    expect(new Set(bundle.artifacts.map((a) => a.contentHash)).size).toBe(4);
  });

  it('encodes the Owner policy rulings that the product already enforces', () => {
    expect(en).toMatch(/cannot be redeemed for cash, cannot be transferred between customers/);
    expect(en).toMatch(/expressly agree to restore/);
    expect(en).toMatch(/unchecked|without ticking|shown unchecked/);
    expect(en).toMatch(/cannot join, rejoin or restore Community, but you can still leave/);
    expect(en).toMatch(/does not make you a Community member/);
  });
});
