import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CUSTOMER-EMAIL-AUTH-POLICY-01: static guards over the deployment configuration TEMPLATES. They read files only (no Worker,
 * no network, no secret) and pin what the owner approved so it cannot drift unnoticed: email sign-up is disabled in every
 * template, the customer password minimum is 8 on both Workers, the approved session lifetimes are coherent, the two open owner
 * decisions are not silently filled in, and the approved customer rate-limit namespace is registered separately for production.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** A tiny TOML reader: `[section]` / `[[array]]` headers and `key = "value"` pairs. Enough for these files, no dependency. */
function sections(text: string): Map<string, Array<Record<string, string>>> {
  const out = new Map<string, Array<Record<string, string>>>();
  let current: Record<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      current = {};
      const name = header[1]!.trim();
      out.set(name, [...(out.get(name) ?? []), current]);
      continue;
    }
    const pair = /^([A-Za-z0-9_]+)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (pair && current) current[pair[1]!] = pair[2]!.replace(/^"|"$/g, '');
  }
  return out;
}
const api = sections(read('apps/api/wrangler.toml'));
const web = sections(read('apps/web/wrangler.toml'));
const apiStaging = Object.assign({}, ...(api.get('env.staging.vars') ?? []));
const webStaging = Object.assign({}, ...(web.get('env.staging.vars') ?? []));

describe('customer email sign-up is enabled in STAGING only', () => {
  it('no section other than env.staging on either Worker enables it (production, cashier-staging and the top level stay off)', () => {
    for (const [file, parsed] of [['api', api], ['web', web]] as const) {
      for (const [section, entries] of parsed) {
        if (section === 'env.staging.vars') continue;
        for (const entry of entries) {
          expect(entry.CUSTOMER_EMAIL_AUTH_ENABLED, `${file} [${section}]`).not.toBe('true');
        }
      }
    }
  });
  it('staging enables the feature on BOTH Workers and production prepares policy without activation', () => {
    expect(apiStaging.CUSTOMER_EMAIL_AUTH_ENABLED).toBe('true');
    expect(webStaging.CUSTOMER_EMAIL_AUTH_ENABLED).toBe('true');
    for (const parsed of [api, web]) {
      for (const entry of parsed.get('vars') ?? []) {
        expect(entry).not.toHaveProperty('CUSTOMER_EMAIL_AUTH_ENABLED');
        expect(entry.CUSTOMER_PASSWORD_MIN_LENGTH).toBe('8');
      }
    }
  });
  it('the example vars file never ships the flag on or a real-looking secret', () => {
    const example = read('apps/api/.dev.vars.example');
    expect(example).not.toMatch(/^\s*CUSTOMER_EMAIL_AUTH_ENABLED\s*=\s*true/m);
    expect(example).not.toMatch(/^\s*CUSTOMER_(EMAIL_AUTH_HMAC|SESSION_SIGNING)_SECRET\s*=/m);
  });
});

describe('PROD-AUTH-02 production policy ready, registration still disabled', () => {
  const apiProduction = Object.assign({}, ...(api.get('vars') ?? []));
  const webProduction = Object.assign({}, ...(web.get('vars') ?? []));
  it('production matches the approved password minimum on API and Web', () => {
    expect(apiProduction.CUSTOMER_PASSWORD_MIN_LENGTH).toBe('8');
    expect(webProduction.CUSTOMER_PASSWORD_MIN_LENGTH).toBe('8');
    expect(apiProduction).not.toHaveProperty('CUSTOMER_EMAIL_AUTH_ENABLED');
    expect(webProduction).not.toHaveProperty('CUSTOMER_EMAIL_AUTH_ENABLED');
  });
  it('production session policies match the approved staging values and remain internally coherent', () => {
    for (const name of [
      'CUSTOMER_SESSION_ACCESS_TTL_SECONDS',
      'CUSTOMER_SESSION_REFRESH_TTL_SECONDS',
      'CUSTOMER_SESSION_ABSOLUTE_TTL_SECONDS',
      'CUSTOMER_SESSION_IDLE_TTL_SECONDS',
      'CUSTOMER_STEP_UP_WINDOW_SECONDS',
    ]) {
      expect(apiProduction[name]).toBe(apiStaging[name]);
    }
    expect(Number(apiProduction.CUSTOMER_SESSION_ACCESS_TTL_SECONDS)).toBeLessThan(Number(apiProduction.CUSTOMER_SESSION_REFRESH_TTL_SECONDS));
    expect(Number(apiProduction.CUSTOMER_SESSION_IDLE_TTL_SECONDS)).toBeLessThanOrEqual(Number(apiProduction.CUSTOMER_SESSION_ABSOLUTE_TTL_SECONDS));
  });
});

describe('approved owner decisions in the staging templates', () => {
  it('the customer password minimum is 8 on BOTH Workers (CA-05, approved 2026-11-16)', () => {
    expect(apiStaging.CUSTOMER_PASSWORD_MIN_LENGTH).toBe('8');
    expect(webStaging.CUSTOMER_PASSWORD_MIN_LENGTH).toBe('8');
  });
  it('the approved session lifetimes are set and coherent (15 minutes access, 30 days absolute and refresh)', () => {
    expect(apiStaging.CUSTOMER_SESSION_ACCESS_TTL_SECONDS).toBe('900');
    expect(apiStaging.CUSTOMER_SESSION_ABSOLUTE_TTL_SECONDS).toBe('2592000');
    expect(apiStaging.CUSTOMER_SESSION_REFRESH_TTL_SECONDS).toBe('2592000');
    expect(Number(apiStaging.CUSTOMER_SESSION_ACCESS_TTL_SECONDS)).toBeLessThan(Number(apiStaging.CUSTOMER_SESSION_REFRESH_TTL_SECONDS));
  });
  it('the idle limit (30 minutes) and step-up window (5 minutes) match the approved decisions and stay coherent', () => {
    expect(apiStaging.CUSTOMER_SESSION_IDLE_TTL_SECONDS).toBe('1800');
    expect(apiStaging.CUSTOMER_STEP_UP_WINDOW_SECONDS).toBe('300');
    expect(Number(apiStaging.CUSTOMER_SESSION_IDLE_TTL_SECONDS)).toBeLessThanOrEqual(Number(apiStaging.CUSTOMER_SESSION_ABSOLUTE_TTL_SECONDS));
  });
});

describe('customer email rate-limit Durable Object deployment configuration', () => {
  const stagingBindings = api.get('env.staging.durable_objects.bindings') ?? [];
  const stagingMigrations = api.get('env.staging.migrations') ?? [];

  it('staging binds CUSTOMER_AUTH_RATE_LIMIT to the existing CustomerEmailRateLimit class and keeps the password hasher', () => {
    expect(stagingBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'CUSTOMER_AUTH_RATE_LIMIT', class_name: 'CustomerEmailRateLimit' }),
      expect.objectContaining({ name: 'PASSWORD_HASHER', class_name: 'PasswordHasherDurableObject' }),
    ]));
  });
  it('the staging migration list restates v1 and adds v2 for the new class, in order', () => {
    expect(stagingMigrations.map((m) => m.tag)).toEqual(['v1', 'v2']);
    expect(stagingMigrations[0]!.new_sqlite_classes).toContain('PasswordHasherDurableObject');
    expect(stagingMigrations[1]!.new_sqlite_classes).toContain('CustomerEmailRateLimit');
  });
  it('the class is exported and production registers the approved rate limiter without changing v1', () => {
    expect(read('apps/api/src/index.ts')).toMatch(/export \{ CustomerEmailRateLimit \} from/);
    expect(api.get('durable_objects.bindings')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'PASSWORD_HASHER', class_name: 'PasswordHasherDurableObject' }),
      expect.objectContaining({ name: 'CUSTOMER_AUTH_RATE_LIMIT', class_name: 'CustomerEmailRateLimit' }),
    ]));
    expect(api.get('durable_objects.bindings')!.map((b) => b.name)).toEqual(['PASSWORD_HASHER', 'CUSTOMER_AUTH_RATE_LIMIT']);
    expect(api.get('migrations')!.map((m) => m.tag)).toEqual(['v1', 'v2']);
    expect(api.get('migrations')![0]!.new_sqlite_classes).toContain('PasswordHasherDurableObject');
    expect(api.get('migrations')![1]!.new_sqlite_classes).toContain('CustomerEmailRateLimit');
  });

  it('the new secrets are NOT in the staging required-secrets list: a missing secret would fail deploys before activation', () => {
    const required = read('apps/api/wrangler.toml');
    const block = /\[env\.staging\.secrets\]\s*required\s*=\s*\[([\s\S]*?)\]/.exec(required)![1]!;
    for (const name of ['CUSTOMER_EMAIL_AUTH_HMAC_SECRET', 'CUSTOMER_SESSION_SIGNING_SECRET', 'CLIENT_ATTRIBUTION_SECRET']) {
      expect(block).not.toContain(name);
    }
  });
});
