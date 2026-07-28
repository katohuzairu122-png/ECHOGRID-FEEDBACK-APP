import { pbkdf2Hash, pbkdf2Verify } from './password';

/**
 * Durable Object wrapping pbkdf2Hash/pbkdf2Verify (password.ts, unchanged)
 * so the actual PBKDF2 compute runs on a Durable Object's own CPU budget
 * (30s default per invocation) instead of the HTTP-handling Worker's --
 * Workers Free plan hard-caps a normal request invocation at 10ms, far
 * below what 600k-iteration PBKDF2 needs. A Worker calling this DO's
 * fetch() counts as I/O wait for the caller, not CPU time, so the calling
 * Worker's own budget is untouched regardless of how long this takes.
 *
 * Generic on iteration count (not hardcoded to the password constant) so
 * this same DO serves both the password path (600k, auth/password.ts) and
 * the OTP path (10k, customer-auth/otp.ts) -- both already share the same
 * underlying pbkdf2Hash/pbkdf2Verify primitive.
 *
 * SQLite-backed (see wrangler.toml's migration entry) because key-value-
 * backed Durable Objects require the Workers Paid plan; SQLite-backed ones
 * are available on Free. No state is actually persisted here -- this DO is
 * purely a CPU-budget escape hatch, never a store.
 */
export class PasswordHasherDurableObject implements DurableObject {
  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as
      | { action: 'hash'; input: string; iterations: number }
      | { action: 'verify'; input: string; storedHash: string };

    if (body.action === 'hash') {
      const result = await pbkdf2Hash(body.input, body.iterations);
      return Response.json({ result });
    }
    if (body.action === 'verify') {
      const result = await pbkdf2Verify(body.input, body.storedHash);
      return Response.json({ result });
    }
    return Response.json({ error: 'Unknown action' }, { status: 400 });
  }
}
