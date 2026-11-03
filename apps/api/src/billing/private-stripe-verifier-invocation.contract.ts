/**
 * S08-PRIVATE-VERIFIER-05: offline-only, fail-closed authenticated invocation contract.
 * This module cannot authenticate callers by itself. The injected authenticator MUST
 * independently verify the transport's identity/capability (not caller-declared headers).
 * The replay store MUST provide atomic one-use claims with durable TTL. No Stripe I/O.
 */
export type InvocationDeny =
  | 'INVALID_REQUEST' | 'AUTHENTICATION_FAILED' | 'CALLER_NOT_APPROVED'
  | 'TARGET_MISMATCH' | 'SCOPE_MISMATCH' | 'APPROVAL_EXPIRED'
  | 'REPLAY_REJECTED' | 'DEPENDENCY_UNAVAILABLE';

export type InvocationRequest = Readonly<{
  audience: string; operation: 'GET /v1/account' | 'GET /v1/invoices/{id}';
  inventoryRevision: string; nonce: string; issuedAt: number; expiresAt: number;
  invoiceId?: string;
}>;

export type VerifiedCaller = Readonly<{
  principal: string; // identity asserted only by an independently verified authenticator
  audience: string; credentialVersion: string;
}>;

export type InvocationPolicy = Readonly<{
  approved: boolean; revoked: boolean; callerPrincipal: string;
  audience: string; credentialVersion: string; inventoryRevision: string;
  methods: readonly InvocationRequest['operation'][];
  expiresAt: number;
}>;

export type InvocationDependencies<Proof> = Readonly<{
  // Failure or null must fail closed. Do not implement by parsing client-supplied claims.
  authenticate: (proof: Proof) => Promise<VerifiedCaller | null>;
  // Must be atomic across isolates, not in-memory. Return false on duplicate.
  claimOnce: (key: string, ttlSeconds: number) => Promise<boolean>;
}>;

export type InvocationDecision =
  | Readonly<{ allowed: false; reason: InvocationDeny }>
  | Readonly<{ allowed: true; principal: string; inventoryRevision: string; operation: InvocationRequest['operation'] }>;

const deny = (reason: InvocationDeny): InvocationDecision => ({ allowed: false, reason });
const token = (x: unknown, max = 160): x is string =>
  typeof x === 'string' && x.length > 0 && x.length <= max &&
  /^[A-Za-z0-9][A-Za-z0-9:_./-]*$/.test(x);
const nonceOk = (x: unknown): x is string =>
  typeof x === 'string' && /^[A-Za-z0-9_-]{24,128}$/.test(x);

export async function authorizePrivateInvocation<Proof>(
  request: InvocationRequest, proof: Proof, policy: InvocationPolicy | null,
  deps: InvocationDependencies<Proof>, now: number,
): Promise<InvocationDecision> {
  if (!Number.isSafeInteger(now) || !request || !token(request.audience) ||
      !token(request.inventoryRevision) || !nonceOk(request.nonce) ||
      !Number.isSafeInteger(request.issuedAt) ||
      !Number.isSafeInteger(request.expiresAt) ||
      request.expiresAt <= request.issuedAt ||
      request.issuedAt > now + 30 || request.expiresAt <= now ||
      request.expiresAt - request.issuedAt > 300 ||
      (request.operation !== 'GET /v1/account' &&
       request.operation !== 'GET /v1/invoices/{id}') ||
      (request.operation === 'GET /v1/account' && request.invoiceId !== undefined) ||
      (request.operation === 'GET /v1/invoices/{id}' &&
        (!token(request.invoiceId) || !/^in_[A-Za-z0-9]+$/.test(request.invoiceId)))) {
    return deny('INVALID_REQUEST');
  }
  if (!policy || policy.approved !== true || policy.revoked !== false ||
      !Number.isSafeInteger(policy.expiresAt) || policy.expiresAt <= now) {
    return deny('APPROVAL_EXPIRED');
  }
  if (!token(policy.callerPrincipal) || !token(policy.audience) ||
      !token(policy.credentialVersion) || !token(policy.inventoryRevision) ||
      !Array.isArray(policy.methods) || !policy.methods.includes(request.operation) ||
      request.inventoryRevision !== policy.inventoryRevision) {
    return deny('SCOPE_MISMATCH');
  }
  if (request.audience !== policy.audience) return deny('TARGET_MISMATCH');
  let caller: VerifiedCaller | null;
  try {
    caller = await deps.authenticate(proof);
  } catch {
    return deny('DEPENDENCY_UNAVAILABLE');
  }
  if (!caller) return deny('AUTHENTICATION_FAILED');
  if (caller.principal !== policy.callerPrincipal ||
      caller.credentialVersion !== policy.credentialVersion) {
    return deny('CALLER_NOT_APPROVED');
  }
  if (caller.audience !== request.audience) return deny('TARGET_MISMATCH');

  // Bind nonce to authenticated principal+audience+inventory revision; the store
  // must atomically reject replay on all Worker isolates and persist through TTL.
  const replayKey = ['s08', caller.principal, request.audience,
    request.inventoryRevision, request.nonce].join(':');
  const ttlSeconds = Math.ceil((request.expiresAt - now) / 1000);
  let claimed = false;
  try {
    claimed = await deps.claimOnce(replayKey, ttlSeconds);
  } catch {
    return deny('DEPENDENCY_UNAVAILABLE');
  }
  if (!claimed) return deny('REPLAY_REJECTED');
  return { allowed: true, principal: caller.principal,
    inventoryRevision: request.inventoryRevision, operation: request.operation };
}
