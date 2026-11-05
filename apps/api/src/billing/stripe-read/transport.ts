import type { FailureClass, ReadMethodId } from './capability-registry';

/**
 * S08-D1D3-DEV-06: the ONLY code in this tree that can reach Stripe, and it can only do one thing: HTTP GET on two fixed paths with a TEST-mode key.
 *
 * It is deliberately not the Stripe SDK client (which exposes the whole API including writes). There is no `request`, `post`, `delete` or generic path argument: the single method
 * takes a registry method id that is one of two literals. The credential lives in this closure; it is never returned, logged, put in an error or exposed as a property. Nothing in
 * this repository constructs this transport outside tests: mounting it in the private verifier Worker needs the separate execution authorization recorded in the inventory.
 */
export const STRIPE_API_VERSION = '2026-05-27.dahlia' as const;
const API_ORIGIN = 'https://api.stripe.com';
const TEST_KEY = /^(rk|sk)_test_[A-Za-z0-9]{8,}$/;
const INVOICE_ID = /^in_[A-Za-z0-9]+$/;
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_BYTES = 256 * 1024;

/** Provider/transport failure. The message is a fixed code: never a response body, header, URL or credential. */
export class ProviderReadError extends Error {
  constructor(readonly failureClass: FailureClass) { super(`STRIPE_READ_${failureClass}`); this.name = 'ProviderReadError'; }
}
export class StripeReadConfigError extends Error {
  constructor(readonly code: 'KEY_NOT_TEST_MODE' | 'TIMEOUT_INVALID' | 'LIMIT_INVALID') { super(`STRIPE_READ_CONFIG_${code}`); this.name = 'StripeReadConfigError'; }
}

export type PerformableMethod = Extract<ReadMethodId, 'ACCOUNT_RETRIEVE_CURRENT' | 'INVOICE_RETRIEVE'>;

/** What the adapter depends on. Fakes implement exactly this; there is no way to express a write or an arbitrary path. */
export interface StripeReadTransport {
  /** The mode of the credential, fixed at construction. Only 'test' exists. */
  readonly keyMode: 'test';
  /** Performs the GET for one registry method and resolves the parsed JSON body of a 2xx response; throws ProviderReadError otherwise. */
  get(method: PerformableMethod, params?: Readonly<{ invoiceId?: string }>): Promise<unknown>;
}

export interface TransportOptions {
  /** A restricted (rk_test_) or secret (sk_test_) TEST key from the server-side secret store. Anything else, including every live key, is refused. */
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export function createStripeGetTransport(opts: TransportOptions): StripeReadTransport {
  const key = opts?.apiKey;
  if (typeof key !== 'string' || !TEST_KEY.test(key)) throw new StripeReadConfigError('KEY_NOT_TEST_MODE'); // never echo the value
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new StripeReadConfigError('TIMEOUT_INVALID');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 4 * 1024 * 1024) throw new StripeReadConfigError('LIMIT_INVALID');
  const doFetch = opts.fetchImpl ?? fetch;

  return Object.freeze({
    keyMode: 'test' as const,
    async get(method: PerformableMethod, params?: Readonly<{ invoiceId?: string }>): Promise<unknown> {
      let path: string;
      if (method === 'ACCOUNT_RETRIEVE_CURRENT') path = '/v1/account';
      else if (method === 'INVOICE_RETRIEVE') {
        const id = params?.invoiceId;
        if (typeof id !== 'string' || !INVOICE_ID.test(id)) throw new ProviderReadError('DENIED');
        path = `/v1/invoices/${id}`;
      } else throw new ProviderReadError('DENIED'); // any other method id, including every unauthorized read and every write-shaped name
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await doFetch(`${API_ORIGIN}${path}`, {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': STRIPE_API_VERSION, Accept: 'application/json' },
        });
      } catch (e) {
        clearTimeout(timer);
        throw new ProviderReadError((e as { name?: string })?.name === 'AbortError' || controller.signal.aborted ? 'TIMEOUT' : 'NETWORK');
      }
      try {
        if (res.status === 429) throw new ProviderReadError('RATE_LIMITED');
        if (res.status >= 500) throw new ProviderReadError('PROVIDER_ERROR');
        if (res.status < 200 || res.status >= 300) throw new ProviderReadError('PROVIDER_REJECTED');
        const declared = Number(res.headers?.get?.('content-length') ?? 0);
        if (Number.isFinite(declared) && declared > maxBytes) throw new ProviderReadError('RESPONSE_TOO_LARGE');
        const text = await res.text();
        if (text.length > maxBytes) throw new ProviderReadError('RESPONSE_TOO_LARGE');
        try { return JSON.parse(text) as unknown; } catch { throw new ProviderReadError('MALFORMED_RESPONSE'); }
      } catch (e) {
        if (e instanceof ProviderReadError) throw e;
        throw new ProviderReadError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK');
      } finally { clearTimeout(timer); }
    },
  });
}
