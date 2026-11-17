import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The web app runs on Cloudflare Workers, whose fetch() does not implement redirect:'error': it throws a TypeError before
 * sending anything (staging email sign-up failed on exactly this). Use redirect:'manual' and treat a 3xx as a failure.
 */
const root = join(__dirname, '..');
function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { yield* sources(path); continue; }
    if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) yield path;
  }
}

describe("no web source uses fetch redirect:'error' (unsupported on Workers)", () => {
  it('finds none', () => {
    const code = (path: string) => readFileSync(path, 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const offenders = [...sources(root)].filter((p) => /redirect\s*:\s*['"]error['"]/.test(code(p))).map((p) => relative(root, p));
    expect(offenders).toEqual([]);
  });
});
