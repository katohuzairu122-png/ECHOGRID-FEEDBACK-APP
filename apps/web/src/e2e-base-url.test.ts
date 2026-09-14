import { describe, it, expect } from 'vitest';
import {
  PRODUCTION_ACK,
  PRODUCTION_HOSTNAMES,
  resolveRemoteBaseUrl,
} from '../e2e/base-url';

/**
 * Lives in src/ rather than next to its subject because vitest.config.ts's
 * include is `src/**` -- the same arrangement src/sw.test.ts uses to test
 * public/sw.js. It cannot move into e2e/: Playwright's default testMatch
 * would pick a `*.test.ts` file up there and try to run it as a spec.
 *
 * WHAT THIS GUARDS (audit P3-5)
 * The old config defaulted baseURL to production, so one command wrote real
 * signups, real public businesses and real billable feedback to the live
 * database. A guard whose failure mode is "silently allows it again" is
 * worth nothing, so the refusal is asserted, not assumed -- and asserted
 * per production hostname, so adding a Custom Domain to wrangler.toml
 * without adding it here shows up as a failing test rather than as a live
 * write.
 */
describe('resolveRemoteBaseUrl', () => {
  const ok = (baseUrl: string | undefined, ack?: string) =>
    resolveRemoteBaseUrl({ baseUrl, ack });

  it('refuses every production hostname when the acknowledgement is absent', () => {
    for (const hostname of PRODUCTION_HOSTNAMES) {
      expect(() => ok(`https://${hostname}`)).toThrow(/that is production/);
    }
  });

  it('refuses production over plain http too', () => {
    // The check is on HOSTNAME, not origin, precisely so this case is
    // caught: http://echo-grid.uk is a different origin and the same
    // database. An origin comparison would have let this through.
    expect(() => ok('http://echo-grid.uk')).toThrow(/that is production/);
  });

  it('refuses production regardless of path, port or casing in the env var', () => {
    expect(() => ok('https://ECHO-GRID.UK')).toThrow(/that is production/);
    expect(() => ok('https://echo-grid.uk/dashboard')).toThrow(/that is production/);
    expect(() => ok('https://echo-grid.uk:443')).toThrow(/that is production/);
  });

  it('is not fooled by a lookalike host that merely ends with the production domain', () => {
    // The class of bug a `endsWith` or `includes` check would have: this is
    // somebody else's host and must NOT be treated as production... but it
    // also must not be silently allowed as a safe target by accident, so
    // assert on what it actually is -- an accepted, non-production host.
    expect(ok('https://echo-grid.uk.attacker.example')).toBe('https://echo-grid.uk.attacker.example');
  });

  it('allows production only with the exact acknowledgement string', () => {
    expect(ok('https://echo-grid.uk', PRODUCTION_ACK)).toBe('https://echo-grid.uk');
  });

  it('rejects a truthy-but-wrong acknowledgement', () => {
    // `E2E_ALLOW_PRODUCTION=1` is the value somebody sets while skimming.
    // A magic string cannot be arrived at by guessing.
    for (const ack of ['1', 'true', 'yes', 'YES-WRITE-TEST-DATA-TO-PRODUCTION', ' ']) {
      expect(() => ok('https://echo-grid.uk', ack)).toThrow(/that is production/);
    }
  });

  it('requires the base URL rather than defaulting to anything', () => {
    // The defect itself: the old config's `?? 'https://echo-grid.uk'`.
    expect(() => ok(undefined)).toThrow(/E2E_BASE_URL is not set/);
    expect(() => ok('')).toThrow(/E2E_BASE_URL is not set/);
    expect(() => ok('   ')).toThrow(/E2E_BASE_URL is not set/);
  });

  it('explains what the specs do, so the failure is self-service', () => {
    // A guard that just says "refused" gets worked around. This asserts the
    // message names the consequence and the escape hatch.
    expect(() => ok('https://echo-grid.uk')).toThrow(/ever cleaned up/);
    expect(() => ok('https://echo-grid.uk')).toThrow(/PLATFORM-WIDE daily spend limit/);
    expect(() => ok('https://echo-grid.uk')).toThrow(new RegExp(PRODUCTION_ACK));
    expect(() => ok(undefined)).toThrow(/no staging environment/);
  });

  it('accepts localhost, which is what the specs are normally run against', () => {
    expect(ok('http://localhost:3000')).toBe('http://localhost:3000');
    expect(ok('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
  });

  it('normalises to the origin, dropping any path or trailing slash', () => {
    // Playwright resolves spec-relative paths like '/signup' against
    // baseURL; a stray path segment here would silently break every goto.
    expect(ok('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(ok('http://localhost:3000/some/path')).toBe('http://localhost:3000');
  });

  it('trims surrounding whitespace, which shells add easily', () => {
    expect(ok('  http://localhost:3000  ')).toBe('http://localhost:3000');
    expect(() => ok('  https://echo-grid.uk  ')).toThrow(/that is production/);
  });

  it('rejects a non-absolute or non-http URL rather than coercing it', () => {
    expect(() => ok('localhost:3000')).toThrow(/must be http or https/); // parses as a URL with protocol 'localhost:'
    expect(() => ok('/signup')).toThrow(/not a valid absolute URL/);
    expect(() => ok('file:///etc/passwd')).toThrow(/must be http or https/);
  });
});
