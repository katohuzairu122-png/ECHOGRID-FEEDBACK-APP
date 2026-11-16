/**
 * CUSTOMER-AUTH-S4-02: resolves the DEDICATED recovery HMAC secret.
 *
 * Never hardcoded, never logged, never derived from another secret. Fails closed:
 * a missing, short or reused value throws, so the recovery services cannot be
 * constructed without a proper secret. Production secrets are not created here;
 * the value is supplied by the environment (`wrangler secret put`) or, in
 * disposable tests, injected.
 */
export const CUSTOMER_RECOVERY_SECRET_NAME = 'CUSTOMER_RECOVERY_HMAC_SECRET';
const MIN_SECRET_BYTES = 32;

export class RecoveryConfigError extends Error {
  constructor(public readonly code: 'missing' | 'too_short' | 'reused') {
    super(`Customer recovery secret is not usable (${code})`);
    this.name = 'RecoveryConfigError';
  }
}

export function assertRecoverySecret(secret: unknown): asserts secret is string {
  if (typeof secret !== 'string' || secret.length === 0) throw new RecoveryConfigError('missing');
  if (new TextEncoder().encode(secret).length < MIN_SECRET_BYTES) throw new RecoveryConfigError('too_short');
}

/** `env` is the Worker bindings object (or a test stand-in). Any OTHER secret-like binding must differ. */
export function resolveCustomerRecoverySecret(env: Record<string, unknown>): string {
  const secret = env[CUSTOMER_RECOVERY_SECRET_NAME];
  assertRecoverySecret(secret);
  for (const [name, value] of Object.entries(env)) {
    if (name === CUSTOMER_RECOVERY_SECRET_NAME) continue;
    if (typeof value === 'string' && /SECRET|KEY|TOKEN/i.test(name) && value === secret) {
      throw new RecoveryConfigError('reused');
    }
  }
  return secret;
}
