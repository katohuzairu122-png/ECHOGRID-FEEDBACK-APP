import 'server-only';
import {
  clearCompatibleCustomerSession,
  getCompatibleCustomerCredentials,
  setRotatingCustomerSession,
  type RotatingCustomerCredentials,
} from './customer-session';

export function readRefreshResponse(payload: unknown): RotatingCustomerCredentials | null {
  if (!payload || typeof payload !== 'object') return null;
  const { accessToken, refreshCredential, accessExpiresAt, refreshExpiresAt } =
    payload as Record<string, unknown>;
  if (typeof accessToken !== 'string' || !accessToken ||
      typeof refreshCredential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(refreshCredential) ||
      typeof accessExpiresAt !== 'string' || typeof refreshExpiresAt !== 'string') return null;
  const accessExpiry = new Date(accessExpiresAt);
  const refreshExpiry = new Date(refreshExpiresAt);
  if (!Number.isFinite(accessExpiry.getTime()) || !Number.isFinite(refreshExpiry.getTime())) return null;
  return { accessToken, refreshCredential, accessExpiresAt: accessExpiry, refreshExpiresAt: refreshExpiry };
}

/** Development composition. The expected origin and API transport come from server configuration. */
export function createCustomerSessionBff(options: {
  origin: string;
  callApi(path: '/refresh' | '/logout', init: RequestInit): Promise<Response>;
}) {
  const send = (path: '/refresh' | '/logout', credential: string) => options.callApi(path, {
    method: 'POST',
    redirect: 'error',
    cache: 'no-store',
    headers: { Authorization: `Bearer ${credential}` },
  });
  return async (request: Request, operation: 'refresh' | 'logout'): Promise<Response> => {
    const status = (code: number) => new Response(null, { status: code, headers: { 'Cache-Control': 'no-store' } });
    if (request.method !== 'POST') return status(405);
    if (!options.origin || request.headers.get('origin') !== options.origin) return status(403);
    try {
      const credentials = await getCompatibleCustomerCredentials();
      if (credentials.kind !== 'rotating') return status(401);

      // An expired access cookie can be absent. Obtain a valid access token for logout
      // from the same refresh chain before revoking it.
      let accessToken = credentials.accessToken;
      if (operation === 'refresh' || !accessToken) {
        if (!credentials.refreshCredential) return status(401);
        const reply = await send('/refresh', credentials.refreshCredential);
        if (reply.status === 401 || reply.status === 409) return status(reply.status);
        if (!reply.ok) return status(503);
        const rotated = readRefreshResponse(await reply.json());
        if (!rotated) return status(503);
        await setRotatingCustomerSession(rotated);
        accessToken = rotated.accessToken;
      }

      if (operation === 'logout' && accessToken) {
        const reply = await send('/logout', accessToken);
        if (!reply.ok) return status(reply.status === 401 ? 401 : 503);
        await clearCompatibleCustomerSession();
      }
      return status(204);
    } catch {
      return status(503);
    }
  };
}
