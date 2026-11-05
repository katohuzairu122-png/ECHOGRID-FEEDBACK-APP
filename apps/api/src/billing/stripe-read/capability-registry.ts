/**
 * S08-D1D3-DEV-06: the provider READ capability registry. A closed, frozen list of the only operations this application may ever ask Stripe to perform. There is no generic
 * "call Stripe" entry point anywhere in this module tree: every provider call is a registry method id, and every method id is GET-only.
 *
 * Two methods are named in the private-verifier inventory (S08-STRIPE-PRIVATE-TEST-VERIFIER-001): GET /v1/account and GET /v1/invoices/{id}. The inventory records BOTH as
 * "PENDING APPROVAL", so they are `APPROVAL_REQUIRED`: they work only while a current, un-revoked, un-expired owner authorization that names the method, the approved test account
 * and the inventory revision is supplied. Without it they are disabled. The other anticipated reads (invoice lines pagination, the settling payment, refunds, disputes) are
 * `NOT_AUTHORIZED` (Q1/Q2): they exist only so the contract and the negative tests are complete, they have no transport path and no configuration can turn them on; enabling one
 * needs a code change that follows an owner authorization.
 */
export type ReadMethodId = 'ACCOUNT_RETRIEVE_CURRENT' | 'INVOICE_RETRIEVE' | 'INVOICE_LINES_LIST' | 'PAYMENT_RETRIEVE' | 'REFUNDS_LIST' | 'DISPUTES_LIST';
export type ReadAuthorizationState = 'APPROVAL_REQUIRED' | 'NOT_AUTHORIZED';
export type FailureClass = 'DENIED' | 'TIMEOUT' | 'NETWORK' | 'RATE_LIMITED' | 'PROVIDER_REJECTED' | 'PROVIDER_ERROR' | 'MALFORMED_RESPONSE' | 'RESPONSE_TOO_LARGE';
export type AuditEventName = 'stripe_read.denied' | 'stripe_read.attempt' | 'stripe_read.success' | 'stripe_read.failure';

export interface ReadMethod {
  readonly id: ReadMethodId;
  /** The ONLY HTTP verb, always GET. There is no field for anything else. */
  readonly http: 'GET';
  readonly pathTemplate: string;
  readonly authorization: ReadAuthorizationState;
  /** Test mode only: a live key, a livemode=true response or an unknown mode is refused for every method. */
  readonly testModeOnly: true;
  readonly requestSchema: string;
  readonly responseContract: string;
  readonly failureClasses: readonly FailureClass[];
  readonly auditEvents: readonly AuditEventName[];
}

const COMMON_FAILURES: readonly FailureClass[] = Object.freeze(['DENIED', 'TIMEOUT', 'NETWORK', 'RATE_LIMITED', 'PROVIDER_REJECTED', 'PROVIDER_ERROR', 'MALFORMED_RESPONSE', 'RESPONSE_TOO_LARGE']);
const COMMON_AUDIT: readonly AuditEventName[] = Object.freeze(['stripe_read.denied', 'stripe_read.attempt', 'stripe_read.success', 'stripe_read.failure']);
const method = (id: ReadMethodId, pathTemplate: string, authorization: ReadAuthorizationState, requestSchema: string, responseContract: string): ReadMethod =>
  Object.freeze({ id, http: 'GET', pathTemplate, authorization, testModeOnly: true, requestSchema, responseContract, failureClasses: COMMON_FAILURES, auditEvents: COMMON_AUDIT });

export const READ_METHODS: Readonly<Record<ReadMethodId, ReadMethod>> = Object.freeze({
  ACCOUNT_RETRIEVE_CURRENT: method('ACCOUNT_RETRIEVE_CURRENT', '/v1/account', 'APPROVAL_REQUIRED', 'none (no parameters, no Stripe-Account header)', 'object=account, id=acct_*'),
  INVOICE_RETRIEVE: method('INVOICE_RETRIEVE', '/v1/invoices/{id}', 'APPROVAL_REQUIRED', 'id=in_*, no expand, no other parameters', 'object=invoice with the fields listed in invoice-normalizer.ts'),
  INVOICE_LINES_LIST: method('INVOICE_LINES_LIST', '/v1/invoices/{id}/lines', 'NOT_AUTHORIZED', 'id=in_*, starting_after, limit', 'UNSPECIFIED until Q1/Q2'),
  PAYMENT_RETRIEVE: method('PAYMENT_RETRIEVE', '/v1/invoice_payments', 'NOT_AUTHORIZED', 'invoice=in_*', 'UNSPECIFIED until Q1/Q2'),
  REFUNDS_LIST: method('REFUNDS_LIST', '/v1/refunds', 'NOT_AUTHORIZED', 'payment reference', 'UNSPECIFIED until Q1/Q2'),
  DISPUTES_LIST: method('DISPUTES_LIST', '/v1/disputes', 'NOT_AUTHORIZED', 'payment reference', 'UNSPECIFIED until Q1/Q2'),
});

/** Only these two may ever be performed by the real transport. Not configurable. */
export const PERFORMABLE_METHODS: readonly ReadMethodId[] = Object.freeze(['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE']);

/** The owner authorization this application needs before it may call the provider. It is configuration/persisted approval, never a caller assertion. */
export interface ReadAuthorization {
  readonly approved: boolean;
  readonly revoked: boolean;
  readonly inventoryRecordId: 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001';
  readonly inventoryRevision: string;
  /** The approved Stripe TEST account (acct_*). Direct account only. */
  readonly accountId: string;
  readonly realm: 'test';
  readonly methods: readonly ReadMethodId[];
  readonly expiresAtMs: number;
}

export type CapabilityDecision =
  | Readonly<{ allowed: true; method: ReadMethod }>
  | Readonly<{ allowed: false; reason: 'UNKNOWN_METHOD' | 'METHOD_NOT_AUTHORIZED' | 'AUTHORIZATION_MISSING' | 'AUTHORIZATION_INVALID' | 'AUTHORIZATION_EXPIRED' | 'AUTHORIZATION_REVOKED' | 'METHOD_NOT_APPROVED' | 'REALM_NOT_TEST' | 'ACCOUNT_NOT_APPROVED' }>;

const ACCOUNT = /^acct_[A-Za-z0-9]+$/;

/** Decides whether `methodId` may be performed NOW. Pure; `nowMs` is the trusted server clock. Every uncertainty is a denial. */
export function decideCapability(methodId: unknown, authorization: ReadAuthorization | null | undefined, nowMs: number): CapabilityDecision {
  if (typeof methodId !== 'string' || !Object.prototype.hasOwnProperty.call(READ_METHODS, methodId)) return { allowed: false, reason: 'UNKNOWN_METHOD' };
  const m = READ_METHODS[methodId as ReadMethodId];
  if (m.authorization === 'NOT_AUTHORIZED' || !PERFORMABLE_METHODS.includes(m.id)) return { allowed: false, reason: 'METHOD_NOT_AUTHORIZED' };
  if (!authorization) return { allowed: false, reason: 'AUTHORIZATION_MISSING' };
  const a = authorization;
  if (a.approved !== true || a.inventoryRecordId !== 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001' || typeof a.inventoryRevision !== 'string' || a.inventoryRevision.length === 0 ||
      !Array.isArray(a.methods) || !Number.isSafeInteger(a.expiresAtMs) || !Number.isSafeInteger(nowMs)) return { allowed: false, reason: 'AUTHORIZATION_INVALID' };
  if (a.revoked !== false) return { allowed: false, reason: 'AUTHORIZATION_REVOKED' };
  if (a.expiresAtMs <= nowMs) return { allowed: false, reason: 'AUTHORIZATION_EXPIRED' };
  if (a.realm !== 'test') return { allowed: false, reason: 'REALM_NOT_TEST' };
  if (typeof a.accountId !== 'string' || !ACCOUNT.test(a.accountId)) return { allowed: false, reason: 'ACCOUNT_NOT_APPROVED' };
  if (!a.methods.includes(m.id)) return { allowed: false, reason: 'METHOD_NOT_APPROVED' };
  return { allowed: true, method: m };
}
