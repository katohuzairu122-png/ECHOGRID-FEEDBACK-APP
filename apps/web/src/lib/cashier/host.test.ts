import { describe, expect, it } from 'vitest';
import { cashierAppUrl, isCashierAppAvailable, isCashierHost, normalizeHost } from './host';

describe('cashier host rules', () => {
  it('normalises case, whitespace and port', () => {
    expect(normalizeHost(' Cashier.Echo-Grid.uk:443 ')).toBe('cashier.echo-grid.uk');
    expect(normalizeHost(null)).toBe('');
  });

  it('matches only the configured cashier host; unset means no host is the cashier host', () => {
    expect(isCashierHost('cashier.echo-grid.uk', 'cashier.echo-grid.uk')).toBe(true);
    expect(isCashierHost('CASHIER.echo-grid.uk:8443', 'cashier.echo-grid.uk')).toBe(true);
    expect(isCashierHost('echo-grid.uk', 'cashier.echo-grid.uk')).toBe(false);
    expect(isCashierHost('evil-cashier.echo-grid.uk', 'cashier.echo-grid.uk')).toBe(false);
    expect(isCashierHost('cashier.echo-grid.uk', undefined)).toBe(false);
    expect(isCashierHost('', '')).toBe(false);
  });

  it('production serves the app only on the cashier host (unset = not deployed anywhere)', () => {
    const prod = { NODE_ENV: 'production', CASHIER_HOST: 'cashier.echo-grid.uk' };
    expect(isCashierAppAvailable('cashier.echo-grid.uk', prod)).toBe(true);
    expect(isCashierAppAvailable('echo-grid.uk', prod)).toBe(false);
    expect(isCashierAppAvailable('echo-grid.uk', { NODE_ENV: 'production' })).toBe(false);
    expect(isCashierAppAvailable('cashier.echo-grid.uk', { NODE_ENV: 'production' })).toBe(false);
  });

  it('development and test serve it on any host', () => {
    expect(isCashierAppAvailable('localhost:3000', { NODE_ENV: 'development' })).toBe(true);
    expect(isCashierAppAvailable('localhost', { NODE_ENV: 'test' })).toBe(true);
  });

  it('the dashboard link points at the configured origin, a local path in development, and nothing in unconfigured production', () => {
    expect(cashierAppUrl({ CASHIER_APP_URL: 'https://cashier.echo-grid.uk/', NODE_ENV: 'production' })).toBe('https://cashier.echo-grid.uk/cashier');
    expect(cashierAppUrl({ NODE_ENV: 'development' })).toBe('/cashier');
    expect(cashierAppUrl({ NODE_ENV: 'production' })).toBeNull();
  });
});
