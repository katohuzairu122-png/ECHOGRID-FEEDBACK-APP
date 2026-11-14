import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import swSource from '../../../public/sw.js?raw';
import { cashierManifest } from '@/lib/cashier/manifest';

vi.mock('next/navigation', () => ({ usePathname: () => '/cashier/redeem' }));

import { CashierTabs } from './cashier-tabs';
import { OfflineBanner } from './offline-banner';

describe('C8 PWA: installability and scope (source level)', () => {
  const manifest = cashierManifest();
  it('is a standalone app with its own id, a start URL inside its scope, and the 192/512 icon pair', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.id).toBe('/cashier');
    expect(manifest.scope).toBe('/cashier/');
    expect(manifest.start_url!.startsWith(manifest.scope!)).toBe(true);
    const sizes = (manifest.icons ?? []).map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.name).not.toBe('Echo Grid'); // distinct from the main app, so it installs separately
  });
});

describe('C8 PWA: no offline loyalty mutations (service worker)', () => {
  it('registers only install, activate and fetch: no background sync, periodic sync, push or message replay', () => {
    const events = [...swSource.matchAll(/addEventListener\(\s*'([a-z]+)'/g)].map((m) => m[1]);
    expect(new Set(events)).toEqual(new Set(['install', 'activate', 'fetch']));
  });
  it('stores nothing but the offline shell: no response caching, so no stale or cross-session loyalty data', () => {
    const code = swSource.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect([...code.matchAll(/cache\.(put|add|addAll)\(([^)]*)\)/g)].map((m) => m[2])).toEqual(['OFFLINE_URL']);
    expect(code).not.toMatch(/IndexedDB|indexedDB|localStorage|BackgroundSync/);
  });
});

describe('C8 PWA: cashier navigation is separate from staff navigation', () => {
  it('offers exactly the counter destinations, all inside /cashier, none of the management areas', () => {
    const tabs = [
      { href: '/cashier', label: 'serve' },
      { href: '/cashier/redeem', label: 'redeem' },
      { href: '/cashier/account', label: 'device' },
    ];
    const { container } = render(<CashierTabs label="nav" tabs={tabs} />);
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/cashier', '/cashier/redeem', '/cashier/account']);
    expect(hrefs.every((h) => h!.startsWith('/cashier'))).toBe(true);
    expect(screen.getByRole('link', { name: 'redeem' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'serve' })).not.toHaveAttribute('aria-current');
  });
});

describe('C8 PWA: offline presentation', () => {
  it('shows an offline notice when the connection drops, and hides it when it returns', () => {
    const set = (v: boolean) => Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: v });
    set(true);
    render(<OfflineBanner title="OFFLINE" body="Nothing is saved offline." />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    act(() => {
      set(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('OFFLINE');
    act(() => {
      set(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears even when the browser never delivers the online event', () => {
    vi.useFakeTimers();
    const set = (v: boolean) => Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: v });
    set(false);
    render(<OfflineBanner title="OFFLINE" body="x" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    set(true);
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});
