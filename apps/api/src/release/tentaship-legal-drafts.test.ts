import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error plain .mjs script without type declarations
import { buildBundle, DOCUMENTS, LOCALES } from '../../scripts/tentaship-legal-bundle.mjs';

/** G10: the Tentaship legal texts exist only as unapproved DRAFTS in four languages; nothing here is published, approved or seeded. */
const dir = join(process.cwd(), '../../docs/legal/tentaship/drafts');
const BANNERS = { en: 'NOT LEGALLY APPROVED', ar: 'غير معتمدة قانونيًا', es: 'SIN APROBACIÓN LEGAL', fr: 'NON APPROUVÉ JURIDIQUEMENT' } as const;

describe('Tentaship legal drafts (G10): unapproved, four languages, tamper-evident', () => {
  it('every document exists in en/ar/es/fr and carries the unapproved banner and counsel placeholders', () => {
    for (const name of Object.keys(DOCUMENTS)) for (const l of LOCALES as (keyof typeof BANNERS)[]) {
      const text = readFileSync(join(dir, `${name}.${l}.md`), 'utf8');
      expect(text, `${name}.${l}`).toContain(BANNERS[l]);
      expect(text.includes('[') && text.includes(']'), `${name}.${l} has placeholders`).toBe(true);
    }
    expect(readdirSync(dir).filter((f) => f.endsWith('.md')).length).toBe(Object.keys(DOCUMENTS).length * LOCALES.length);
  });
  it('no draft states an odds, prize, guarantee, price or legal conclusion', () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const t = readFileSync(join(dir, f), 'utf8').toLowerCase();
      expect(t, f).not.toMatch(/guarantee|odds of|probabilit|you will win|no purchase necessary|\$\s?\d|garantiz|garanti|مضمون|احتمال الفوز/);
    }
  });
  it('the committed manifest matches the files and approves/publishes nothing (hashes are tamper evidence only)', () => {
    const committed = JSON.parse(readFileSync(join(dir, 'BUNDLE.draft.json'), 'utf8'));
    expect(committed).toEqual(buildBundle());
    expect(Object.values(committed.publication).every((v) => v === null)).toBe(true);
    expect(Object.values(committed.translationApproval).every((v) => v === null)).toBe(true);
    const reg = new Set(committed.documents.flatMap((d: { registerItems: string[] }) => d.registerItems)); for (const id of ['L-1', 'L-2', 'L-3', 'L-4', 'L-5', 'L-6']) expect(reg.has(id), id).toBe(true);
  });
});
