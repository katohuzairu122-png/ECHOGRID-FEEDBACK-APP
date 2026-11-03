import { describe, expect, it } from 'vitest';
import {
  PRIVATE_VERIFIER_INVENTORY_ID, preflightPrivateStripeVerifier,
  type VerifierExecution, type VerifierInventory,
} from './private-stripe-test-verifier.preflight';

const approved: VerifierInventory = {
  inventoryId: PRIVATE_VERIFIER_INVENTORY_ID,
  revision: 'synthetic-r1',
  approved: true,
  approvalReference: 'synthetic-approval',
  approvalExpiresAt: 3000,
  revoked: false,
  expectedAccountId: 'acct_SYNTHETIC123',
  realm: 'test',
  workloadIdentity: 'synthetic-private-principal',
  executionPath: 'synthetic-private-runner',
  environment: 'synthetic-test-env',
  credentialInventoryRef: 'synthetic-secret-inventory-ref',
  credentialVersion: 'synthetic-v1',
  methods: ['GET /v1/account', 'GET /v1/invoices/{id}'],
};
const execution: VerifierExecution = {
  inventoryRevision: 'synthetic-r1', now: 2000,
  workloadIdentity: 'synthetic-private-principal',
  executionPath: 'synthetic-private-runner',
  environment: 'synthetic-test-env',
  credentialInventoryRef: 'synthetic-secret-inventory-ref',
  credentialVersion: 'synthetic-v1',
  requestedMethod: 'GET /v1/account',
};

describe('S08 private Stripe verifier approval preflight (synthetic only)', () => {
  it('denies an absent inventory before any provider access', () => {
    expect(preflightPrivateStripeVerifier(null, execution)).toEqual({ allowed: false, reason: 'INVENTORY_INCOMPLETE' });
  });

  it.each([
    ['pending approval', { approved: false }, 'APPROVAL_MISSING'],
    ['revoked inventory', { revoked: true }, 'APPROVAL_MISSING'],
    ['approval expired', { approvalExpiresAt: 2000 }, 'APPROVAL_EXPIRED'],
    ['live realm', { realm: 'live' }, 'INVENTORY_INCOMPLETE'],
    ['invalid account', { expectedAccountId: '' }, 'INVENTORY_INCOMPLETE'],
    ['unversioned credential', { credentialVersion: '' }, 'INVENTORY_INCOMPLETE'],
    ['missing approval record', { approvalReference: '' }, 'APPROVAL_MISSING'],
    ['read method not approved', { methods: ['GET /v1/account'] }, 'METHOD_UNAPPROVED'],
  ] as const)('%s is denied', (_label, change, reason) => {
    const actualExecution = reason === 'METHOD_UNAPPROVED'
      ? { ...execution, requestedMethod: 'GET /v1/invoices/{id}' as const } : execution;
    expect(preflightPrivateStripeVerifier({ ...approved, ...change } as VerifierInventory, actualExecution))
      .toEqual({ allowed: false, reason });
  });

  it.each([
    ['wrong inventory revision', { inventoryRevision: 'r2' }, 'SCOPE_UNAPPROVED'],
    ['wrong principal', { workloadIdentity: 'other' }, 'WORKLOAD_UNAPPROVED'],
    ['wrong runner', { executionPath: 'other' }, 'WORKLOAD_UNAPPROVED'],
    ['wrong environment', { environment: 'other' }, 'WORKLOAD_UNAPPROVED'],
    ['wrong credential version', { credentialVersion: 'other' }, 'CREDENTIAL_UNVERIFIED'],
    ['wrong secret reference', { credentialInventoryRef: 'other' }, 'CREDENTIAL_UNVERIFIED'],
    ['connected override', { connectedAccountOverride: 'acct_OTHER' }, 'ACCOUNT_OVERRIDE'],
  ] as const)('%s is denied', (_label, change, reason) => {
    expect(preflightPrivateStripeVerifier(approved, { ...execution, ...change }))
      .toEqual({ allowed: false, reason });
  });

  it('only approves an already approved and exact synthetic read scope', () => {
    const result = preflightPrivateStripeVerifier(approved, execution);
    expect(result).toEqual({
      allowed: true, expectedAccountId: approved.expectedAccountId,
      inventoryRevision: approved.revision, apiVersion: '2026-05-27.dahlia',
    });
    // Preflight is not a Stripe identity attestation and cannot verify invoices.
    expect(result).not.toHaveProperty('invoiceVerified');
  });
});
