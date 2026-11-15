import { describe, expect, it } from 'vitest';
import { cashierAppUrl, configuredCashierHost, isCashierAppAvailable, isCashierHost, isDevAnyHostEnabled, normalizeHost } from './host';

describe('cashier host rules (fail closed)', () => {
  it('normalises case, whitespace and port', () => {
    expect(normalizeHost(' Cashier.Echo-Grid.uk:443 ')).toBe('cashier.echo-grid.uk');
    expect(normalizeHost(null)).toBe('');
  });

  it('matches only the configured, well-formed cashier host', () => {
    expect(isCashierHost('cashier.echo-grid.uk', 'cashier.echo-grid.uk')).toBe(true);
    expect(isCashierHost('CASHIER.echo-grid.uk:8443', 'cashier.echo-grid.uk')).toBe(true);
    expect(isCashierHost('echo-grid.uk', 'cashier.echo-grid.uk')).toBe(false);
    expect(isCashierHost('evil-cashier.echo-grid.uk', 'cashier.echo-grid.uk')).toBe(false);
    expect(isCashierHost('cashier.echo-grid.uk.evil.example', 'cashier.echo-grid.uk')).toBe(false);
  });

  it.each([undefined, '', '   ', 'https://cashier.echo-grid.uk', 'cashier.echo-grid.uk/path', '*.echo-grid.uk', 'cashier echo-grid.uk', 'user@cashier.echo-grid.uk', '-bad.example', 'bad-.example', 'a..b', '.example', 'ünï.example'])(
    'an unset or malformed CASHIER_HOST (%j) serves nothing, on any host',
    (value) => {
      expect(configuredCashierHost(value)).toBeNull();
      for (const host of ['cashier.echo-grid.uk', 'echo-grid.uk', 'localhost', '', null]) {
        expect(isCashierHost(host, value as string | undefined)).toBe(false);
        expect(isCashierAppAvailable(host, { CASHIER_HOST: value, NODE_ENV: 'production' })).toBe(false);
        expect(isCashierAppAvailable(host, { CASHIER_HOST: value })).toBe(false); // NODE_ENV missing: still closed
        expect(isCashierAppAvailable(host, { CASHIER_HOST: value, NODE_ENV: 'development' })).toBe(false); // no opt-in: closed
      }
    },
  );

  it('a missing or unexpected NODE_ENV is never permission', () => {
    for (const NODE_ENV of [undefined, '', 'development', 'test', 'staging', 'banana']) {
      expect(isCashierAppAvailable('echo-grid.uk', { NODE_ENV, CASHIER_HOST: 'cashier.echo-grid.uk' }), String(NODE_ENV)).toBe(false);
      expect(isCashierAppAvailable('cashier.echo-grid.uk', { NODE_ENV, CASHIER_HOST: 'cashier.echo-grid.uk' }), String(NODE_ENV)).toBe(true);
    }
  });

  it('staging and production serve the cashier host only', () => {
    for (const env of [
      { NODE_ENV: 'production', CASHIER_HOST: 'echo-grid-feedback-cashier-staging.katohuzairu122.workers.dev' },
      { NODE_ENV: 'production', CASHIER_HOST: 'cashier.echo-grid.uk' },
    ]) {
      expect(isCashierAppAvailable(env.CASHIER_HOST, env)).toBe(true);
      expect(isCashierAppAvailable('echo-grid.uk', env)).toBe(false);
      expect(isCashierAppAvailable('echo-grid-feedback-web-staging.katohuzairu122.workers.dev', env)).toBe(false);
    }
  });

  it('local development needs the EXPLICIT opt-in, and the opt-in is ignored in production', () => {
    expect(isDevAnyHostEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(isDevAnyHostEnabled({ NODE_ENV: 'development', CASHIER_DEV_ANY_HOST: '1' })).toBe(true);
    expect(isDevAnyHostEnabled({ NODE_ENV: 'production', CASHIER_DEV_ANY_HOST: '1' })).toBe(false);
    expect(isDevAnyHostEnabled({ NODE_ENV: 'development', CASHIER_DEV_ANY_HOST: 'true' })).toBe(false);
    expect(isCashierAppAvailable('localhost:3000', { NODE_ENV: 'development', CASHIER_DEV_ANY_HOST: '1' })).toBe(true);
    expect(isCashierAppAvailable('echo-grid.uk', { NODE_ENV: 'production', CASHIER_DEV_ANY_HOST: '1' })).toBe(false);
  });

  it('the dashboard link points at the configured origin, a local path only with the opt-in, and nothing otherwise', () => {
    expect(cashierAppUrl({ CASHIER_APP_URL: 'https://cashier.echo-grid.uk/', NODE_ENV: 'production' })).toBe('https://cashier.echo-grid.uk/cashier');
    expect(cashierAppUrl({ NODE_ENV: 'development', CASHIER_DEV_ANY_HOST: '1' })).toBe('/cashier');
    expect(cashierAppUrl({ NODE_ENV: 'development' })).toBeNull();
    expect(cashierAppUrl({ NODE_ENV: 'production' })).toBeNull();
    expect(cashierAppUrl({})).toBeNull();
  });
});
