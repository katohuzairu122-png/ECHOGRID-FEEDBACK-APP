import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..');
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
});

describe('TB-03 structural containment', () => {
  it('no loyalty, cashier or customer-points module references the badge engine: a cashier transaction can never award a badge', () => {
    for (const dir of ['loyalty', 'cashier-accounts', 'cashier-sessions', 'cashier-activity', 'community', 'orphan-settlement', 'partner-credits']) {
      for (const file of files(join(SRC, dir))) {
        expect(readFileSync(file, 'utf8'), file).not.toMatch(/tentaship-badges|tentashipBadge|BadgeAwardService/);
      }
    }
  });

  it('every file that can write the badge ledger is inside the tentaship-badges module', () => {
    const writers = files(SRC).filter((f) => /insert\(tentashipBadgeAwards\)|insert\(tentashipBadgeRevocations\)/.test(readFileSync(f, 'utf8')));
    expect(writers.map((f) => f.slice(SRC.length + 1))).toEqual(['tentaship-badges/badge-award.service.ts']);
  });

  it('badge routes mount the gate before authentication, and no badge route is cashier-reachable', () => {
    const routes = readFileSync(join(SRC, 'tentaship-badges', 'badge-routes.ts'), 'utf8');
    expect(routes).toMatch(/use\('\*', tentashipBadgesGate, customerAuthenticate/);
    expect(routes).toMatch(/use\('\*', tentashipBadgesGate, authenticate/);
    const platform = readFileSync(join(SRC, 'platform', 'tentaship-badge.routes.ts'), 'utf8');
    expect(platform).toMatch(/use\('\*', tentashipBadgesGate, authenticate, requirePlatformRole\(\['admin'\]\)\)/);
  });

  it('badges are not currency: the schema has no balance, amount, value, price or transfer column', () => {
    const schema = readFileSync(join(SRC, 'db', 'schema', 'tentaship-badges.ts'), 'utf8');
    expect(schema).not.toMatch(/\b(balance|amount|price|currency|value|transfer|cash|wager|entry)\w*\s*:\s*(integer|numeric|text|uuid)\(/i);
  });

  it('no wrangler configuration sets the control: it is activated only by an authorised operation', () => {
    for (const f of ['wrangler.toml', 'wrangler.jsonc']) {
      try { expect(readFileSync(resolve(SRC, '..', f), 'utf8')).not.toMatch(/TENTASHIP_BADGES_ENABLED/); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  });
});
