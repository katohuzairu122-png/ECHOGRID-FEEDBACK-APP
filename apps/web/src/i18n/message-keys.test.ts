import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * next-intl treats "." in a message key as nesting and rejects the key with INVALID_KEY, which surfaced as errors on
 * every page once a namespace shipped keys such as `loyalty.customer_lookup` (found by the main-branch browser run). No
 * message file in any locale may contain a dotted key.
 */
const root = join(__dirname, '../../messages');

function dottedKeys(value: unknown, path: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    ...(k.includes('.') ? [[...path, k].join(' > ')] : []),
    ...dottedKeys(v, [...path, k]),
  ]);
}

describe('message files', () => {
  for (const locale of readdirSync(root)) {
    for (const file of readdirSync(join(root, locale)).filter((f) => f.endsWith('.json'))) {
      it(`${locale}/${file} has no dotted keys`, () => {
        expect(dottedKeys(JSON.parse(readFileSync(join(root, locale, file), 'utf8')))).toEqual([]);
      });
    }
  }
});
