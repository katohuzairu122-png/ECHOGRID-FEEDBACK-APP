'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';

/**
 * Unread message counts for the menu badge, the tab title and the installed app's icon badge. One shared poller per
 * source, however many badges are on screen (sidebar, bottom bar and sheet all show the same item), so the page
 * makes one request per interval, not one per badge.
 *
 * It refreshes when the first badge appears, every 45 seconds while the tab is visible, and straight away when the
 * tab becomes visible again, regains focus or the connection returns. A failed or rejected request counts as zero
 * for the badge and backs the interval off (up to 5 minutes), so a rate limit or an outage can never break the page
 * or make it worse. It stops when the last badge goes away.
 */
export type UnreadSource = 'staff-messages' | 'customer-messages';

const ENDPOINT: Record<UnreadSource, string> = {
  'staff-messages': '/api/messaging/unread',
  'customer-messages': '/api/loyalty/unread',
};
export const POLL_INTERVAL_MS = 45_000;
export const MAX_BACKOFF_MS = 300_000;

interface Entry {
  count: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  failures: number;
  inFlight: boolean;
}

const entries = new Map<UnreadSource, Entry>();
let globalListenersAttached = false;

function entry(source: UnreadSource): Entry {
  let found = entries.get(source);
  if (!found) {
    found = { count: 0, listeners: new Set(), timer: null, failures: 0, inFlight: false };
    entries.set(source, found);
  }
  return found;
}

const TITLE_PREFIX = /^\((?:\d+|99\+)\)\s/;

/** Tab title "(3) Echo Grid" and the installed app's icon badge, from the sum of the active sources. */
function applyEffects(): void {
  if (typeof document === 'undefined') return;
  let total = 0;
  for (const e of entries.values()) if (e.listeners.size > 0) total += e.count;
  const base = document.title.replace(TITLE_PREFIX, '');
  document.title = total > 0 ? `(${total > 99 ? '99+' : total}) ${base}` : base;
  const nav = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    const pending = total > 0 ? nav.setAppBadge?.(total) : nav.clearAppBadge?.();
    void pending?.catch(() => undefined);
  } catch {
    /* the Badging API is optional */
  }
}

function notify(e: Entry): void {
  for (const listener of e.listeners) listener();
}

async function refresh(source: UnreadSource): Promise<void> {
  const e = entry(source);
  if (e.inFlight || e.listeners.size === 0) return;
  e.inFlight = true;
  try {
    const response = await fetch(ENDPOINT[source], {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !type.includes('application/json')) throw new Error('unread unavailable');
    const body = (await response.json()) as { unreadMessages?: unknown };
    const next =
      typeof body.unreadMessages === 'number' && body.unreadMessages > 0
        ? Math.floor(body.unreadMessages)
        : 0;
    e.failures = 0;
    if (next !== e.count) {
      e.count = next;
      notify(e);
    }
  } catch {
    e.failures += 1;
  } finally {
    e.inFlight = false;
    applyEffects();
  }
}

function schedule(source: UnreadSource): void {
  const e = entry(source);
  if (e.timer) clearTimeout(e.timer);
  if (e.listeners.size === 0) return;
  const delay = Math.min(POLL_INTERVAL_MS * 2 ** e.failures, MAX_BACKOFF_MS);
  e.timer = setTimeout(async () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible')
      await refresh(source);
    schedule(source);
  }, delay);
}

function refreshAllNow(): void {
  for (const [source, e] of entries) {
    if (e.listeners.size === 0) continue;
    void refresh(source);
    schedule(source);
  }
}

function onVisibility(): void {
  if (document.visibilityState === 'visible') refreshAllNow();
}

function attachGlobalListeners(): void {
  if (globalListenersAttached || typeof window === 'undefined') return;
  globalListenersAttached = true;
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', refreshAllNow);
  window.addEventListener('online', refreshAllNow);
}

function detachGlobalListeners(): void {
  if (!globalListenersAttached || typeof window === 'undefined') return;
  if ([...entries.values()].some((e) => e.listeners.size > 0)) return;
  globalListenersAttached = false;
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('focus', refreshAllNow);
  window.removeEventListener('online', refreshAllNow);
}

export function subscribeUnread(source: UnreadSource, listener: () => void): () => void {
  const e = entry(source);
  const first = e.listeners.size === 0;
  e.listeners.add(listener);
  if (first) {
    attachGlobalListeners();
    void refresh(source);
    schedule(source);
  }
  return () => {
    e.listeners.delete(listener);
    if (e.listeners.size === 0) {
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      e.count = 0;
      e.failures = 0;
      detachGlobalListeners();
      applyEffects();
    }
  };
}

export function getUnreadCount(source: UnreadSource): number {
  return entries.get(source)?.count ?? 0;
}

/**
 * The unread count for one source (0 until the first answer, and on any failure). The subscribe function must keep
 * its identity between renders: React resubscribes whenever it changes, which would restart the poller every render.
 */
export function useUnreadCount(source: UnreadSource): number {
  const subscribe = useCallback(
    (listener: () => void) => subscribeUnread(source, listener),
    [source],
  );
  const getSnapshot = useCallback(() => getUnreadCount(source), [source]);
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}

/** The sum over several sources (the "More" button on a small screen, which hides some menu items). */
export function useUnreadTotal(sources: readonly UnreadSource[]): number {
  const key = sources.join('|');
  const list = useMemo(() => (key ? (key.split('|') as UnreadSource[]) : []), [key]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribers = list.map((source) => subscribeUnread(source, listener));
      return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
    },
    [list],
  );
  const getSnapshot = useCallback(
    () => list.reduce((sum, source) => sum + getUnreadCount(source), 0),
    [list],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}

/** Test helper: forget every source, timer and listener. */
export function resetUnreadStoreForTests(): void {
  for (const e of entries.values()) if (e.timer) clearTimeout(e.timer);
  entries.clear();
  if (globalListenersAttached && typeof window !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', refreshAllNow);
    window.removeEventListener('online', refreshAllNow);
  }
  globalListenersAttached = false;
}
