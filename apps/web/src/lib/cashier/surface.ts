import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * CASHIER-PWA-01 C4: which credential family the current server work runs under. The cashier app reuses the existing
 * Serve Customers server actions (customer lookup, scanning, purchases, redemptions) instead of copying them; those
 * actions call `apiFetch`, which asks this module whose token to send. Only the cashier action wrappers enter the
 * cashier surface, so every other call keeps using the staff cookies exactly as before.
 */
const store = new AsyncLocalStorage<{ surface: 'cashier' }>();

export function runInCashierSurface<T>(work: () => Promise<T>): Promise<T> {
  return store.run({ surface: 'cashier' }, work);
}

export function isCashierSurface(): boolean {
  return store.getStore()?.surface === 'cashier';
}
