import { describe, it, expect, vi } from 'vitest';
import swSource from '../public/sw.js?raw';

/**
 * Regression tests for public/sw.js -- the PWA service worker.
 *
 * It had none, for a structural reason: it is not a module. It is a script
 * that calls `self.addEventListener(...)` at import time against globals
 * (`self`, `caches`, `fetch`, `Response`) that exist in a
 * ServiceWorkerGlobalScope and nowhere else. Nothing imports it, so nothing
 * could test it, so the one behaviour that matters most -- what a user sees
 * when the network is gone -- was only ever verified by hand.
 *
 * HOW IT IS LOADED HERE
 * ---------------------------------------------------------------------
 * The source is pulled in as a STRING via Vite's `?raw` suffix (see
 * raw-modules.d.ts for why that suffix is typed locally), then evaluated
 * with `new Function` against fakes passed as parameters. Parameters shadow
 * globals inside the function body, so the worker runs against a controlled
 * scope with no globals patched and nothing to restore between tests.
 *
 * `Response` is faked rather than taken from the runtime on purpose. jsdom
 * does not implement it, Node's global comes from undici, and which one wins
 * under `environment: 'jsdom'` is an implementation detail nobody should
 * have to care about. A fake makes the status/headers assertions exact.
 *
 * THE TEST THAT MATTERS MOST
 * ---------------------------------------------------------------------
 * "serves the inline last-resort page when the network is down AND the cache
 * is empty". Before the `??` fallback was added, a cache miss resolved
 * `undefined`, and `respondWith(undefined)` is a TypeError the browser
 * surfaces as a raw network-error page -- one dropped connection reading as
 * a dead site, on mobile, which is the exact scenario this worker exists
 * for. Run that test against the pre-fix source and it fails with
 * `UNDEFINED -> TypeError`.
 */

const CACHE_NAME = 'echo-grid-shell-v1';
const OFFLINE_URL = '/offline.html';

/** Minimal stand-in for the Response constructor the worker calls. Records
 * exactly what was passed so assertions can be specific about status and
 * headers rather than settling for "it returned something". */
class FakeResponse {
  constructor(
    readonly body: string,
    readonly init: { status?: number; statusText?: string; headers?: Record<string, string> } = {},
  ) {}
  get status() {
    return this.init.status ?? 200;
  }
  get statusText() {
    return this.init.statusText ?? '';
  }
  get headers() {
    return this.init.headers ?? {};
  }
}

type Handler = (event: Record<string, unknown>) => void;

interface FakeCache {
  add: ReturnType<typeof vi.fn>;
  match: ReturnType<typeof vi.fn>;
}

/**
 * Evaluates the real sw.js against fakes and returns everything a test needs
 * to drive it. `cachedOfflineShell` is what `cache.match(OFFLINE_URL)`
 * resolves to -- pass null to model an evicted or never-installed shell.
 */
function loadServiceWorker(
  options: {
    existingCacheKeys?: string[];
    cachedOfflineShell?: unknown;
    fetchImpl?: () => Promise<unknown>;
  } = {},
) {
  const handlers = new Map<string, Handler>();

  const cache: FakeCache = {
    add: vi.fn(async () => undefined),
    match: vi.fn(async () => options.cachedOfflineShell ?? undefined),
  };

  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => options.existingCacheKeys ?? []),
    delete: vi.fn(async () => true),
    // Deliberately present and deliberately never expected to be called:
    // the fetch handler must scope its lookup to its OWN cache, not this
    // all-caches search, so a shell left behind by an older CACHE_NAME can
    // never be served. A test asserts this stays untouched.
    match: vi.fn(async () => undefined),
  };

  const self = {
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  };

  const fetchMock = vi.fn(options.fetchImpl ?? (async () => new FakeResponse('network')));

  // No eslint-disable needed: this config extends tseslint's `recommended`,
  // which does not enable no-implied-eval (that lives in
  // recommended-type-checked), and core eslint:recommended does not enable
  // no-new-func. An unused disable directive would itself warn under ESLint
  // 9's default reportUnusedDisableDirectives.
  new Function('self', 'caches', 'fetch', 'Response', swSource)(self, caches, fetchMock, FakeResponse);

  return { handlers, self, caches, cache, fetchMock };
}

/** Fires a lifecycle handler and resolves whatever it handed to
 * `waitUntil`, so assertions run after the worker's own async work. */
async function runLifecycle(handler: Handler | undefined): Promise<void> {
  expect(handler).toBeTypeOf('function');
  let pending: Promise<unknown> = Promise.resolve();
  handler!({ waitUntil: (p: Promise<unknown>) => (pending = p) });
  await pending;
}

/** Fires the fetch handler for one request and returns what it passed to
 * `respondWith` -- or the symbol NOT_HANDLED when it passed the request
 * through without responding at all. */
const NOT_HANDLED = Symbol('not handled');
async function runFetch(handler: Handler | undefined, mode: string): Promise<unknown> {
  expect(handler).toBeTypeOf('function');
  let responded: unknown = NOT_HANDLED;
  handler!({
    request: { mode, url: 'https://echo-grid.uk/dashboard' },
    respondWith: (value: unknown) => (responded = value),
  });
  return responded === NOT_HANDLED ? NOT_HANDLED : await responded;
}

describe('service worker: install', () => {
  it('caches the offline shell under this version\'s cache name and activates immediately', async () => {
    const { handlers, caches, cache, self } = loadServiceWorker();

    await runLifecycle(handlers.get('install'));

    expect(caches.open).toHaveBeenCalledWith(CACHE_NAME);
    expect(cache.add).toHaveBeenCalledWith(OFFLINE_URL);
    // Without skipWaiting the new worker sits idle behind the old one until
    // every tab closes -- a fix could ship and not take effect for days.
    expect(self.skipWaiting).toHaveBeenCalled();
  });
});

describe('service worker: activate', () => {
  it('deletes caches from older versions and keeps the current one', async () => {
    const { handlers, caches } = loadServiceWorker({
      existingCacheKeys: ['echo-grid-shell-v0', CACHE_NAME, 'some-other-cache'],
    });

    await runLifecycle(handlers.get('activate'));

    expect(caches.delete).toHaveBeenCalledWith('echo-grid-shell-v0');
    expect(caches.delete).toHaveBeenCalledWith('some-other-cache');
    // The one that must survive: deleting it here would evict the shell
    // install() just wrote, leaving the worker with nothing to fall back to.
    expect(caches.delete).not.toHaveBeenCalledWith(CACHE_NAME);
  });

  it('claims open clients so the new worker controls already-open tabs', async () => {
    const { handlers, self } = loadServiceWorker();
    await runLifecycle(handlers.get('activate'));
    expect(self.clients.claim).toHaveBeenCalled();
  });
});

describe('service worker: fetch', () => {
  it('ignores every non-navigation request -- API calls and session traffic pass through untouched', async () => {
    const { handlers, fetchMock, caches } = loadServiceWorker();

    for (const mode of ['cors', 'no-cors', 'same-origin']) {
      expect(await runFetch(handlers.get('fetch'), mode)).toBe(NOT_HANDLED);
    }

    // Not merely "didn't respond" -- it must not touch the network or the
    // cache on this path either. Caching authenticated responses on a shared
    // device is the failure this restraint prevents.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(caches.open).not.toHaveBeenCalled();
  });

  it('serves the network response for a navigation when the network is up, without consulting the cache', async () => {
    const live = new FakeResponse('live page');
    const { handlers, caches, cache } = loadServiceWorker({ fetchImpl: async () => live });

    expect(await runFetch(handlers.get('fetch'), 'navigate')).toBe(live);
    expect(cache.match).not.toHaveBeenCalled();
    expect(caches.open).not.toHaveBeenCalled();
  });

  it('falls back to the cached offline shell when the network is unreachable', async () => {
    const shell = new FakeResponse('cached offline shell');
    const { handlers, caches, cache } = loadServiceWorker({
      cachedOfflineShell: shell,
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });

    expect(await runFetch(handlers.get('fetch'), 'navigate')).toBe(shell);

    // Scoped to this worker's own cache, never the all-caches search: a
    // stale shell under an older CACHE_NAME must not be reachable.
    expect(caches.open).toHaveBeenCalledWith(CACHE_NAME);
    expect(cache.match).toHaveBeenCalledWith(OFFLINE_URL);
    expect(caches.match).not.toHaveBeenCalled();
  });

  it('serves the inline last-resort page when the network is down AND the cache is empty', async () => {
    // The regression this file exists for. A cache miss resolves undefined,
    // and respondWith(undefined) throws a TypeError the browser renders as a
    // raw network-error page. Against the pre-fix source this assertion
    // fails with UNDEFINED -> TypeError.
    const { handlers } = loadServiceWorker({
      cachedOfflineShell: null,
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });

    const response = (await runFetch(handlers.get('fetch'), 'navigate')) as FakeResponse;

    expect(response).toBeInstanceOf(FakeResponse);
    expect(response).not.toBeUndefined();
    // 503, not 200: a navigation that claims success while serving a
    // placeholder can be cached or bookmarked as though it were real content.
    expect(response.status).toBe(503);
    expect(response.statusText).toBe('Offline');
    expect(response.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(response.headers['Cache-Control']).toBe('no-store');
    // Self-contained markup, not a second cache entry -- anything living in
    // the cache can be absent for exactly the reasons that got us here.
    expect(response.body).toContain('offline');
    expect(response.body).toContain('<!doctype html>');
  });
});
