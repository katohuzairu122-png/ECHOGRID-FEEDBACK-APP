import { describe, it, expect } from 'vitest';
import { parseAllowedOrigins, assertRedirectOriginAllowed } from './allowed-origins';
import { AppError } from './errors';

// The real production value, so these tests exercise the shape the deployed
// Worker actually parses (apps/api/wrangler.toml's [vars]).
const RAW = 'http://localhost:3000,https://echo-grid.uk,https://echo-grid-feedback-web.katohuzairu122.workers.dev';
const ALLOWED = parseAllowedOrigins(RAW);

describe('parseAllowedOrigins', () => {
  it('splits the production value into its three origins', () => {
    expect(ALLOWED).toEqual([
      'http://localhost:3000',
      'https://echo-grid.uk',
      'https://echo-grid-feedback-web.katohuzairu122.workers.dev',
    ]);
  });

  it('tolerates whitespace and trailing commas, which a hand-edited [vars] string collects', () => {
    expect(parseAllowedOrigins(' https://a.example , https://b.example ,')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('yields an empty list for undefined or empty, so callers fail closed', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins(',,  ,')).toEqual([]);
  });
});

describe('assertRedirectOriginAllowed', () => {
  const check = (url: string, allowed: readonly string[] = ALLOWED) =>
    assertRedirectOriginAllowed(url, allowed, 'successUrl');

  it('allows every origin the platform serves the app from', () => {
    expect(() => check('https://echo-grid.uk/dashboard/billing?status=ok')).not.toThrow();
    expect(() => check('http://localhost:3000/dashboard/billing')).not.toThrow();
    expect(() =>
      check('https://echo-grid-feedback-web.katohuzairu122.workers.dev/dashboard'),
    ).not.toThrow();
  });

  it('ignores path, query and fragment -- only the origin is this check\'s business', () => {
    expect(() => check('https://echo-grid.uk')).not.toThrow();
    expect(() => check('https://echo-grid.uk/')).not.toThrow();
    expect(() => check('https://echo-grid.uk/a/b/c?d=e#f')).not.toThrow();
  });

  it('rejects an unrelated origin', () => {
    expect(() => check('https://attacker.example/collect')).toThrow(AppError);
  });

  it('rejects a suffix attack that a startsWith check would have allowed', () => {
    // The reason this compares parsed origins rather than string prefixes.
    // Both of these begin with an allow-listed entry.
    expect(() => check('https://echo-grid.uk.attacker.example/collect')).toThrow(AppError);
    expect(() => check('https://echo-grid.ukattacker.example/')).toThrow(AppError);
  });

  it('rejects a different scheme or port on an allowed host', () => {
    // Origin is scheme + host + port. http:// to a host allow-listed only
    // over https is a downgrade, and a different port is a different service.
    expect(() => check('http://echo-grid.uk/dashboard')).toThrow(AppError);
    expect(() => check('https://echo-grid.uk:8443/dashboard')).toThrow(AppError);
    expect(() => check('http://localhost:3001/dashboard')).toThrow(AppError);
  });

  it('rejects credentials embedded to disguise the real host', () => {
    // Reads as echo-grid.uk to a human skimming the URL; the origin is
    // attacker.example.
    expect(() => check('https://echo-grid.uk@attacker.example/collect')).toThrow(AppError);
  });

  it('rejects non-http schemes outright', () => {
    expect(() => check('javascript:alert(1)')).toThrow(AppError);
    expect(() => check('data:text/html,<script>alert(1)</script>')).toThrow(AppError);
  });

  it('fails closed on an empty allow-list rather than allowing everything', () => {
    expect(() => check('https://echo-grid.uk/dashboard', [])).toThrow(AppError);
  });

  it('answers 422 with one code and names the offending field', () => {
    let thrown: unknown;
    try {
      assertRedirectOriginAllowed('https://attacker.example', ALLOWED, 'returnUrl');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(AppError);
    const appError = thrown as AppError;
    expect(appError.status).toBe(422);
    expect(appError.code).toBe('REDIRECT_ORIGIN_NOT_ALLOWED');
    // The field name reaches the client, so a misconfigured frontend can
    // tell which of three URLs it got wrong.
    expect(appError.message).toContain('returnUrl');
  });
});
