/**
 * S08-PRIVATE-VERIFIER-05 — offline-only authorization contract.
 * NO runtime authenticator, durable replay store, Stripe I/O or deployment.
 *
 * authenticate MUST cryptographically verify an assertion over the exact
 * canonical request supplied here. Returning caller data without verifying
 * that request is a security violation; the synthetic adapter is NOT trusted.
 */
export type InvocationDeny =
  | 'INVALID_REQUEST' | 'AUTHENTICATION_FAILED' | 'CALLER_NOT_APPROVED'
  | 'TARGET_MISMATCH' | 'SCOPE_MISMATCH' | 'APPROVAL_EXPIRED'
  | 'REPLAY_REJECTED' | 'DEPENDENCY_UNAVAILABLE';

export const MAX_INVOCATION_LIFETIME_MS = 5 * 60 * 1000;
export const MAX_CLOCK_SKEW_MS = 30 * 1000;

export type InvoiceInvocationScope = Readonly<{
  invoiceId: string;
  businessId: string;
  customerId: string;
  subscriptionId: string;
}>;

export type InvocationRequest = Readonly<{
  audience: string;
  operation: 'GET /v1/account' | 'GET /v1/invoices/{id}';
  inventoryRevision: string;
  nonce: string;
  /** All time fields must be Unix epoch milliseconds. */
  issuedAt: number;
  expiresAt: number;
  invoiceScope?: InvoiceInvocationScope;
}>;

export type VerifiedCaller = Readonly<{
  principal: string;
  audience: string;
  credentialVersion: string;
  /** Canonical request authenticated by a trusted proof verifier. */
  authenticatedRequest: string;
}>;

export type InvocationPolicy = Readonly<{
  approved: boolean;
  revoked: boolean;
  callerPrincipal: string;
  audience: string;
  credentialVersion: string;
  inventoryRevision: string;
  methods: readonly InvocationRequest['operation'][];
  expiresAt: number;
  /** Trusted and immutable, not obtained from the caller's request. */
  invoiceScope?: InvoiceInvocationScope;
}>;

export type InvocationDependencies<Proof> = Readonly<{
  /**
   * Verify proof's signature/MAC, audience, key version, lifetime and the
   * supplied canonical request *as one atomic validation*. Must reject
   * proofs bound to another request; do not trust caller-supplied claims.
   */
  authenticate: (proof: Proof, canonicalRequest: string) => Promise<VerifiedCaller | null>;
  /**
   * Atomic across all isolates and durable for ttlSeconds; fail closed on
   * any uncertainty. In-memory Set and KV read-then-write are unsuitable.
   */
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
const invoiceIdOk = (x: unknown): x is string =>
  token(x) && /^in_[A-Za-z0-9]+$/.test(x);
const scopeOk = (scope: unknown): scope is InvoiceInvocationScope =>
  scope !== null && typeof scope === 'object' &&
  invoiceIdOk((scope as InvoiceInvocationScope).invoiceId) &&
  token((scope as InvoiceInvocationScope).businessId) &&
  token((scope as InvoiceInvocationScope).customerId) &&
  token((scope as InvoiceInvocationScope).subscriptionId);
const sameScope = (a: InvoiceInvocationScope, b: InvoiceInvocationScope) =>
  a.invoiceId === b.invoiceId && a.businessId === b.businessId &&
  a.customerId === b.customerId && a.subscriptionId === b.subscriptionId;

/**
 * Deterministic canonical string; external authenticator must verify a
 * signature over these exact bytes, not merely copy supplied values.
 * Uses fixed field order and JSON arrays to avoid separator collisions.
 */
export function canonicalPrivateInvocation(request: InvocationRequest): string {
  return JSON.stringify(['S08-PV05-v1', request.audience, request.operation,
    request.inventoryRevision, request.nonce, request.issuedAt, request.expiresAt,
    request.invoiceScope
      ? [request.invoiceScope.invoiceId, request.invoiceScope.businessId,
        request.invoiceScope.customerId, request.invoiceScope.subscriptionId]
      : null]);
}

export async function authorizePrivateInvocation<Proof>(
  request: InvocationRequest,
  proof: Proof,
  policy: InvocationPolicy | null,
  deps: InvocationDependencies<Proof>,
  now: number,
): Promise<InvocationDecision> {
  if (!Number.isSafeInteger(now) || !request || !token(request.audience) ||
      !token(request.inventoryRevision) || !nonceOk(request.nonce) ||
      !Number.isSafeInteger(request.issuedAt) ||
      !Number.isSafeInteger(request.expiresAt) ||
      request.expiresAt <= request.issuedAt ||
      request.issuedAt > now + MAX_CLOCK_SKEW_MS || request.expiresAt <= now ||
      request.expiresAt - request.issuedAt > MAX_INVOCATION_LIFETIME_MS ||
      (request.operation !== 'GET /v1/account' &&
       request.operation !== 'GET /v1/invoices/{id}') ||
      (request.operation === 'GET /v1/account' && request.invoiceScope !== undefined) ||
      (request.operation === 'GET /v1/invoices/{id}' && !scopeOk(request.invoiceScope))) {
    return deny('INVALID_REQUEST');
  }
  if (!policy || policy.approved !== true || policy.revoked !== false ||
      !Number.isSafeInteger(policy.expiresAt) || policy.expiresAt <= now) {
    return deny('APPROVAL_EXPIRED');
  }
  if (!token(policy.callerPrincipal) || !token(policy.audience) ||
      !token(policy.credentialVersion) || !token(policy.inventoryRevision) ||
      !Array.isArray(policy.methods) || !policy.methods.includes(request.operation) ||
      request.inventoryRevision !== policy.inventoryRevision ||
      request.expiresAt > policy.expiresAt) {
    return deny('SCOPE_MISMATCH');
  }
  if (request.audience !== policy.audience) return deny('TARGET_MISMATCH');
  if (request.operation === 'GET /v1/invoices/{id}' &&
      (!scopeOk(policy.invoiceScope) ||
       !sameScope(request.invoiceScope!, policy.invoiceScope))) {
    return deny('SCOPE_MISMATCH');
  }
  // Caller must be authenticated against the full, canonical, validated
  // request. Without a verified request-bound proof, no operation is allowed.
  const canonicalRequest = canonicalPrivateInvocation(request);
  let caller: VerifiedCaller | null;
  try {
    caller = await deps.authenticate(proof, canonicalRequest);
  } catch {
    return deny('DEPENDENCY_UNAVAILABLE');
  }
  if (!caller || caller.authenticatedRequest !== canonicalRequest) {
    return deny('AUTHENTICATION_FAILED');
  }
  if (caller.principal !== policy.callerPrincipal ||
      caller.credentialVersion !== policy.credentialVersion) {
    return deny('CALLER_NOT_APPROVED');
  }
  if (caller.audience !== request.audience) return deny('TARGET_MISMATCH');

  // JSON array encoding prevents ambiguity if identifiers contain colons.
  const replayKey = JSON.stringify(['s08', caller.principal, request.audience,
    request.inventoryRevision, request.nonce]);
  const ttlSeconds = Math.ceil((request.expiresAt - now) / 1000);
  let claimed: boolean;
  try {
    claimed = await deps.claimOnce(replayKey, ttlSeconds);
  } catch {
    return deny('DEPENDENCY_UNAVAILABLE');
  }
  if (claimed !== true) return deny('REPLAY_REJECTED');
  return { allowed: true, principal: caller.principal,
    inventoryRevision: request.inventoryRevision, operation: request.operation };
}
