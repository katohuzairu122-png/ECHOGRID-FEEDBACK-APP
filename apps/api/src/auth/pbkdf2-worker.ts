import { pbkdf2Hash, pbkdf2Verify } from './password';

/**
 * What AuthService/CustomerAuthService actually depend on -- not the raw
 * DurableObjectNamespace binding, and not pbkdf2Hash/pbkdf2Verify directly.
 * Two implementations below: one for the real deployed Worker (routes
 * through the PasswordHasherDurableObject, see password-hasher.do.ts), one
 * for plain-Node unit tests (calls the primitive in-process, no Workers
 * runtime available or needed there).
 */
export interface Pbkdf2Worker {
  hash(input: string, iterations: number): Promise<string>;
  verify(input: string, storedHash: string): Promise<boolean>;
}

/**
 * In-process implementation -- used by unit tests (auth.service.test.ts,
 * customer-auth.service.test.ts) that construct services directly against
 * fake repos under plain Node, same reasoning as those tests' existing
 * fake-repo helpers: no real Workers runtime, no DO, and Node has neither
 * the 100k-iteration single-call cap nor the 10ms CPU cap this whole
 * abstraction exists to work around.
 */
export function createDirectPbkdf2Worker(): Pbkdf2Worker {
  return {
    hash: (input, iterations) => pbkdf2Hash(input, iterations),
    verify: (input, storedHash) => pbkdf2Verify(input, storedHash),
  };
}

/**
 * Real implementation -- routes each call to a fresh Durable Object
 * instance via newUniqueId() (not a fixed/shared name), so concurrent
 * signups/logins/OTP-verifies run on separate DO instances instead of
 * serializing through one actor (Durable Objects process requests to the
 * same instance one at a time).
 */
export function createDurableObjectPbkdf2Worker(namespace: DurableObjectNamespace): Pbkdf2Worker {
  async function call(body: Record<string, unknown>): Promise<{ result: unknown }> {
    const id = namespace.newUniqueId();
    const stub = namespace.get(id);
    const response = await stub.fetch('https://password-hasher/', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`PasswordHasherDurableObject request failed: ${response.status}`);
    }
    return response.json();
  }

  return {
    async hash(input, iterations) {
      const { result } = await call({ action: 'hash', input, iterations });
      return result as string;
    },
    async verify(input, storedHash) {
      const { result } = await call({ action: 'verify', input, storedHash });
      return result as boolean;
    },
  };
}
