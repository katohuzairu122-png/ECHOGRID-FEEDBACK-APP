import 'server-only';
import { z } from 'zod';
import {
  clearCompatibleCustomerSession,
  getCompatibleCustomerCredentials,
  setRotatingCustomerSession,
} from './customer-session';

const refreshedCredentials = z.object({
  accessToken: z.string().min(1),
  refreshCredential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  accessExpiresAt: z.iso.datetime().transform((value) => new Date(value)),
  refreshExpiresAt: z.iso.datetime().transform((value) => new Date(value)),
}).strict();

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
        const parsed = refreshedCredentials.safeParse(await reply.json());
        if (!parsed.success) return status(503);
        await setRotatingCustomerSession(parsed.data);
        accessToken = parsed.data.accessToken;
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
