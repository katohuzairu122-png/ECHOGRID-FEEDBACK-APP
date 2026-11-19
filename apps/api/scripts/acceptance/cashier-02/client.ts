import { assertAllowedUrl, type FetchFn, type GuardedTargets } from './guard';
import { STRICT_PATH, type Pacer } from './pace';
import { redactString } from './redact';

export interface CallOptions {
  token?: string;
  businessId?: string;
  branchId?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error?: { code?: string; message?: string };
}

/** What the scenarios use. Live runs get the network client; local tests get an in-process one. Both return the same shape. */
export interface ApiClient {
  request(method: string, path: string, opts?: CallOptions): Promise<ApiResult>;
}

function toHeaders(opts: CallOptions): Record<string, string> {
  const h: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) h.authorization = `Bearer ${opts.token}`;
  if (opts.businessId) h['x-business-id'] = opts.businessId;
  if (opts.branchId) h['x-branch-id'] = opts.branchId;
  if (opts.body !== undefined) h['content-type'] = 'application/json';
  return h;
}

export async function parseEnvelope(res: Response): Promise<ApiResult> {
  const text = await res.text();
  let json: { data?: unknown; error?: { code?: string; message?: string } } = {};
  try {
    json = text ? (JSON.parse(text) as typeof json) : {};
  } catch {
    json = {};
  }
  return { status: res.status, data: json.data, ...(json.error ? { error: json.error } : {}) };
}

/**
 * The live client. It only accepts guarded targets, re-checks every URL, refuses redirects, paces strict calls, and its
 * errors never carry request or response content.
 */
export function createLiveClient(targets: GuardedTargets, deps: { fetch: FetchFn; pacer: Pacer }): ApiClient {
  return {
    async request(method, path, opts = {}) {
      if (!path.startsWith('/')) throw new Error('request path must start with "/"');
      const url = assertAllowedUrl(targets, `${targets.apiBase}${path}`);
      return deps.pacer.run(STRICT_PATH.test(path), async () => {
        try {
          const res = await deps.fetch(url.toString(), {
            method,
            headers: toHeaders(opts),
            redirect: 'error',
            ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
          });
          return await parseEnvelope(res);
        } catch (error) {
          throw new Error(`request failed: ${method} ${path} (${redactString(error instanceof Error ? error.name : 'error')})`);
        }
      });
    },
  };
}

/** Local tests: calls an in-process application (for example a Hono app) with no network and no pacing. */
export function createInProcessClient(handle: (method: string, path: string, opts: CallOptions) => Promise<ApiResult>): ApiClient {
  return { request: (method, path, opts = {}) => handle(method, path, opts) };
}
