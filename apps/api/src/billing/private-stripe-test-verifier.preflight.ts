/**
 * S08-PRIVATE-VERIFIER-01: offline, deny-by-default workload/credential approval
 * preflight. No SDK, secrets, network, invoice retrieval or operational authority.
 *
 * An approved inventory MUST be supplied from an independently authenticated
 * control plane; this pure function does not authenticate signatures or obtain
 * approval from a committed repository document.
 */
export const PRIVATE_VERIFIER_INVENTORY_ID = 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001' as const;
export const PRIVATE_VERIFIER_API_VERSION = '2026-05-27.dahlia' as const;

export type VerifierMethod = 'GET /v1/account' | 'GET /v1/invoices/{id}';
export type VerifierDenial =
  | 'INVENTORY_INCOMPLETE'
  | 'APPROVAL_MISSING'
  | 'APPROVAL_EXPIRED'
  | 'CREDENTIAL_UNVERIFIED'
  | 'WORKLOAD_UNAPPROVED'
  | 'METHOD_UNAPPROVED'
  | 'SCOPE_UNAPPROVED'
  | 'ACCOUNT_OVERRIDE';

export type VerifierInventory = Readonly<{
  inventoryId: string;
  revision: string;
  approved: boolean;
  approvalReference: string;
  approvalExpiresAt: number;
  revoked: boolean;
  expectedAccountId: string;
  realm: 'test' | 'live';
  workloadIdentity: string;
  executionPath: string;
  environment: string;
  credentialInventoryRef: string;
  credentialVersion: string;
  methods: readonly VerifierMethod[];
}>;

export type VerifierExecution = Readonly<{
  inventoryRevision: string;
  now: number;
  workloadIdentity: string;
  executionPath: string;
  environment: string;
  credentialInventoryRef: string;
  credentialVersion: string;
  requestedMethod: VerifierMethod;
  connectedAccountOverride?: string | null;
}>;

export type VerifierPreflight =
  | Readonly<{ allowed: false; reason: VerifierDenial }>
  | Readonly<{ allowed: true; expectedAccountId: string; inventoryRevision: string; apiVersion: typeof PRIVATE_VERIFIER_API_VERSION }>;

const specified = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.trim() === s && !s.includes('\n');
const accountId = (s: unknown): s is string => specified(s) && /^acct_[A-Za-z0-9]+$/.test(s);
const deny = (reason: VerifierDenial): VerifierPreflight => ({ allowed: false, reason });

export function preflightPrivateStripeVerifier(inventory: VerifierInventory | null, execution: VerifierExecution): VerifierPreflight {
  // Treat all caller input and inventory objects as untrusted. No secrets are accepted or returned.
  if (!inventory || inventory.inventoryId !== PRIVATE_VERIFIER_INVENTORY_ID ||
      !specified(inventory.revision) || !accountId(inventory.expectedAccountId) ||
      inventory.realm !== 'test' || !specified(inventory.workloadIdentity) ||
      !specified(inventory.executionPath) || !specified(inventory.environment) ||
      !specified(inventory.credentialInventoryRef) || !specified(inventory.credentialVersion) ||
      !Array.isArray(inventory.methods) || !Number.isSafeInteger(inventory.approvalExpiresAt)) return deny('INVENTORY_INCOMPLETE');

  if (inventory.approved !== true || inventory.revoked !== false ||
      !specified(inventory.approvalReference)) return deny('APPROVAL_MISSING');
  if (!Number.isSafeInteger(execution.now) || execution.now >= inventory.approvalExpiresAt) return deny('APPROVAL_EXPIRED');
  if (!specified(execution.inventoryRevision) || execution.inventoryRevision !== inventory.revision) return deny('SCOPE_UNAPPROVED');

  if (execution.workloadIdentity !== inventory.workloadIdentity ||
      execution.executionPath !== inventory.executionPath ||
      execution.environment !== inventory.environment) return deny('WORKLOAD_UNAPPROVED');

  if (!specified(execution.credentialInventoryRef) || !specified(execution.credentialVersion) ||
      execution.credentialInventoryRef !== inventory.credentialInventoryRef ||
      execution.credentialVersion !== inventory.credentialVersion) return deny('CREDENTIAL_UNVERIFIED');

  if (execution.connectedAccountOverride !== undefined && execution.connectedAccountOverride !== null) return deny('ACCOUNT_OVERRIDE');
  if (execution.requestedMethod !== 'GET /v1/account' && execution.requestedMethod !== 'GET /v1/invoices/{id}') return deny('METHOD_UNAPPROVED');
  if (!inventory.methods.includes(execution.requestedMethod)) return deny('METHOD_UNAPPROVED');

  return { allowed: true, expectedAccountId: inventory.expectedAccountId, inventoryRevision: inventory.revision, apiVersion: PRIVATE_VERIFIER_API_VERSION };
}
