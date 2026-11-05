import type { InvocationPolicy, InvocationRequest } from '../private-stripe-verifier-invocation.contract';
import { benefitIdempotencyKey } from '../settlement-eligibility.classifier';
import type { AcquisitionBinding, AcquisitionConfig } from './acquisition-pipeline';
import type { ReadAuthorization } from './capability-registry';
import type { TrustedInvoiceScope } from './invoice-normalizer';
import { syntheticStripeInvoice } from './mock-provider';
import type { InvocationPair } from './trusted-evidence-service';
import { createMockReadProvider, createRealReadProvider, type MockProviderFixtures, type RealReadProvider } from './read-provider';
import { StripeReadOnlyEvidenceAdapter } from './adapter';
import { createObservationVerifier, type KeyPurpose, type RuntimeSigner, type TrustedKeyEntry, type TrustedKeyRing, type TrustedReadRuntime } from './trusted-runtime';
import { createSyntheticTrustedRuntime } from './synthetic-runtime';
import type { AuditSink } from './read-types';
import type { StripeReadTransport } from './transport';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { captureProof, type ProofStore } from './proof-capture';
import { onePage } from './extended-source';

/**
 * S08-D1D3-DEV-08: SYNTHETIC fixtures for the acquisition pipeline tests: Stripe-shaped objects in the SDK-profile shape (not proven live), a trusted binding and an invocation harness.
 * Nothing here is a credential, a real identifier or policy: the freshness window and policy instant are TEST CONFIGURATION (Q3 and Q14 are undecided).
 */
export const API = '2026-05-27.dahlia';
export const ACCT = 'acct_TestSyntheticAccount1';
export const NOW = 1_700_001_000_000;
export const CREATED_S = 1_700_000_000;
export const PAID_S = 1_700_000_100;
export const SCOPE: TrustedInvoiceScope = { businessId: 'biz-1', invoiceId: 'in_1', customerId: 'cus_1', subscriptionId: 'sub_1' };
export const KEY = benefitIdempotencyKey('res-1');
const D = (c: string) => c.repeat(64).slice(0, 64);

export const AUTH: ReadAuthorization = { approved: true, revoked: false, inventoryRecordId: 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001', inventoryRevision: 'rev-synthetic-1', accountId: ACCT, realm: 'test',
  methods: ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'], expiresAtMs: NOW + 3_600_000 };
export const CONFIG: AcquisitionConfig = { freshnessWindowMs: 3_600_000, policyEffectiveFromMs: 1_000, policyVersion: 'PC-BENEFIT/1' };

export const invoice = (over: Record<string, unknown> = {}) => syntheticStripeInvoice(SCOPE, { amount_due: 2700, amount_paid: 2700, amount_remaining: 0, total: 2700, created: CREATED_S,
  status_transitions: { finalized_at: CREATED_S, marked_uncollectible_at: null, paid_at: PAID_S, voided_at: null },
  lines: { object: 'list', has_more: false, data: [{ id: 'il_base', amount: 3000, currency: 'usd' }, { id: 'il_ben', amount: -300, currency: 'usd' }] }, ...over });
export const subParent = (proration = false) => ({ type: 'subscription_item_details', invoice_item_details: null, subscription_item_details: { invoice_item: null, proration, subscription: 'sub_1', subscription_item: 'si_1' } });
export const itemParent = (item: string | null = 'ii_ben') => ({ type: 'invoice_item_details', subscription_item_details: null, invoice_item_details: { invoice_item: item, proration: false, subscription: 'sub_1' } });
export const line = (id: string, amount: number, parent: unknown, over: Record<string, unknown> = {}) => ({ id, object: 'line_item', amount, currency: 'usd', invoice: 'in_1', livemode: false, metadata: {}, parent, ...over });
export const baseLines = () => [line('il_base', 3000, subParent()), line('il_ben', -300, itemParent())];
export const pay = (over: Record<string, unknown> = {}) => ({ id: 'inpay_1', object: 'invoice_payment', amount_paid: 2700, amount_requested: 2700, created: CREATED_S + 50, currency: 'usd', invoice: 'in_1', is_default: true, livemode: false,
  payment: { type: 'payment_intent', payment_intent: 'pi_1' }, status: 'paid', status_transitions: { paid_at: PAID_S, canceled_at: null }, ...over });
export const refund = (over: Record<string, unknown> = {}) => ({ id: 're_1', object: 'refund', amount: 500, charge: 'ch_1', created: PAID_S + 10, currency: 'usd', payment_intent: 'pi_1', status: 'succeeded', ...over });
export const dispute = (over: Record<string, unknown> = {}) => ({ id: 'dp_1', object: 'dispute', amount: 2700, charge: 'ch_1', created: PAID_S + 10, currency: 'usd', livemode: false, payment_intent: 'pi_1', status: 'needs_response', ...over });
export const account = { object: 'account', id: ACCT };

export const BENEFIT_ITEM = { itemRef: 'ii_ben', invoiceRef: 'in_1', idempotencyKey: KEY, amountMinor: -300, currency: 'usd', discountable: false } as const;

export function binding(over: Partial<AcquisitionBinding['classifier']> & { scope?: TrustedInvoiceScope; expectedAccountId?: string } = {}): AcquisitionBinding {
  const { scope, expectedAccountId, ...cls } = over;
  return {
    scope: scope ?? SCOPE, expectedAccountId: expectedAccountId ?? ACCT,
    classifier: {
      binding: { businessId: 'biz-1', reservationId: 'res-1', intentRef: 'intent-1' },
      expected: { businessId: 'biz-1', reservationId: 'res-1', intentRef: 'intent-1', invoiceRef: 'in_1', customerRef: 'cus_1', subscriptionRef: 'sub_1', currency: 'usd', providerAccountId: ACCT, providerMode: 'test',
        reservationExpiresAtMs: NOW + 86_400_000,
        frozenAllocation: { artifactVersion: 1, allocationPolicyVersion: 'S08-AGG-ROUND/1', benefitPolicyVersion: 'PC-BENEFIT/1', businessId: 'biz-1', invoiceRef: 'in_1', currency: 'usd', eligibleBaseMinor: 3000,
          eligibleCreditBalance: 1, unitsToApply: 1, aggregateBenefitMinor: 300, percentApplied: 1,
          allocations: [{ reservationId: 'res-1', invoiceIntentRef: 'intent-1', units: 1, benefitMinor: 300, providerIdempotencyKey: KEY }], allocationDigest: D('a'), providerVerified: false, consumptionAuthorized: false } as never },
      expectedPaymentRef: 'pi_1', consumedAtMs: null, ...cls,
    },
  };
}

export function mockFixtures(over: Partial<MockProviderFixtures> = {}): MockProviderFixtures {
  return {
    account, invoices: [invoice()], lines: onePage(baseLines()), payments: onePage([pay()]), refunds: onePage([]), disputes: onePage([]),
    supplement: { billingInterval: 'month', benefitItem: BENEFIT_ITEM, cancellation: 'none', idempotency: [{ parentItemRef: 'ii_ben', idempotencyKey: KEY }] }, ...over,
  };
}
export const mockProvider = (over: Partial<MockProviderFixtures> = {}) => createMockReadProvider(mockFixtures(over));

/** Private-verifier invocation harness for the REAL-provider path: a request-bound proof is "valid" only when it equals the literal 'valid'. */
export function invocationHarness() {
  const audience = 'echo-grid-s08-stripe-test-verifier';
  const policy: InvocationPolicy = { approved: true, revoked: false, callerPrincipal: 'caller-1', audience, credentialVersion: 'v1', inventoryRevision: 'rev-synthetic-1',
    methods: ['GET /v1/account', 'GET /v1/invoices/{id}'], expiresAt: NOW + 3_600_000, invoiceScope: { ...SCOPE } };
  const seen = new Set<string>();
  const deps = {
    authenticate: async (proof: string, canonical: string) => (proof === 'valid' ? { principal: 'caller-1', audience, credentialVersion: 'v1', authenticatedRequest: canonical } : null),
    claimOnce: async (k: string) => { if (seen.has(k)) return false; seen.add(k); return true; },
  };
  const req = (n: string, op: InvocationRequest['operation']): InvocationRequest => ({ audience, operation: op, inventoryRevision: 'rev-synthetic-1', nonce: n.repeat(24), issuedAt: NOW - 1_000, expiresAt: NOW + 60_000,
    ...(op === 'GET /v1/invoices/{id}' ? { invoiceScope: { ...SCOPE } } : {}) });
  let n = 0;
  const pair = (proof = 'valid'): InvocationPair<string> => { const c = String.fromCharCode(97 + (n++ % 26)); return { account: { request: req(c + 'x', 'GET /v1/account'), proof }, invoice: { request: req(c + 'y', 'GET /v1/invoices/{id}'), proof } }; };
  return { policy, deps, pair };
}

// ---- DEV-09: trusted read gate fixtures -------------------------------------------------------------------------------------------------------------------------------------------------------
import { MappingRegistry, DEFAULT_MAPPING_CATALOG, type ProofLookup } from './mapping-authority';
import { createInMemoryAuthorizationStore, type ReadAuthorizationRecord } from './read-authorization';
import type { ReadGate } from './read-gate';
import { READ_METHODS } from './capability-registry';

export const WORKLOAD = 'wl-verifier-1';
export const SYNTHETIC_ACCOUNT_KEY = ['rk', 'test', 'SyntheticKeyMaterial0123456789'].join('_');

/**
 * TEST FIXTURE ONLY. Stands in for a persisted store of REAL captured proofs so that the gate's behaviour with a verified mapping can be exercised. It proves nothing about Stripe: a mapping becomes
 * verified in production only through a real-network proof (proof-capture.ts), and `MappingRegistry.load` honours a verified entry only when such a proof exists.
 */
const fixtureProofs: ProofLookup = { get: id => (id.startsWith('proof-fixture:') ? { captureOrigin: 'REAL_NETWORK', methodId: id.split(':')[1]!, apiVersion: API } : null) };
export function verifiedMapping(ops: readonly string[] = ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE']): MappingRegistry {
  const entries = DEFAULT_MAPPING_CATALOG.map(m => (ops.includes(m.sourceOperation) && m.status === 'SDK_SCHEMA_UNPROVEN_LIVE' ? { ...m, status: 'TEST_MODE_VERIFIED', verifiedByProofId: `proof-fixture:${m.sourceOperation}` } : m));
  return MappingRegistry.load(entries, fixtureProofs)!;
}

export function recordFor(methodId: string, over: Partial<ReadAuthorizationRecord> = {}): ReadAuthorizationRecord {
  return { authorizationId: `auth-${methodId}`, businessId: 'biz-1', accountId: ACCT, realm: 'test', workloadId: WORKLOAD, methodId: methodId as never, state: 'PENDING', approvedBy: null, validFromMs: 1, expiresAtMs: NOW + 3_600_000,
    revokedAtMs: null, version: 1, inventoryRecordId: 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001', inventoryRevision: 'rev-synthetic-1', ...over };
}

/** A gate built from a legacy-shaped authorization description: one APPROVED record per listed method (or PENDING / REVOKED as described), a read-only store, this workload and a mapping state. */
export function gateFor(auth: ReadAuthorization | null, o: { mapping?: MappingRegistry; workloadId?: string; businessId?: string } = {}) {
  const { store, admin } = createInMemoryAuthorizationStore();
  if (auth) {
    for (const methodId of auth.methods) {
      if (!Object.prototype.hasOwnProperty.call(READ_METHODS, methodId)) continue;
      const added = admin.add(recordFor(methodId, { accountId: auth.accountId, realm: auth.realm, businessId: o.businessId ?? 'biz-1', expiresAtMs: auth.expiresAtMs }));
      if (!added.ok) continue; // a record that cannot be valid (for example a live realm or a malformed account) simply does not exist
      if (auth.approved) admin.apply(`auth-${methodId}`, { type: 'APPROVE', approvedBy: 'owner-approver-1' }, 2);
      if (auth.revoked) admin.apply(`auth-${methodId}`, { type: 'REVOKE' }, 3);
    }
  }
  const gate: ReadGate = { store, workloadId: o.workloadId ?? WORKLOAD, mapping: o.mapping ?? verifiedMapping() };
  return Object.assign(gate, { admin });
}


// ---- DEV-10 synthetic trust fixtures (TEST FIXTURES ONLY: a generated throwaway key, never a real signing authority) ----------------------------------------------------------------------------------

export interface SyntheticTrust {
  readonly signer: RuntimeSigner;
  /** Mutable on purpose: tests revoke or expire the key by editing this entry. */
  readonly entry: { -readonly [K in keyof TrustedKeyEntry]: TrustedKeyEntry[K] };
  readonly keyRing: () => TrustedKeyRing;
  readonly keyId: string;
}
/** A freshly generated Ed25519 key pair registered with the given purpose. Throwaway and in-memory; the private key never leaves this closure. */
export function syntheticTrust(purpose: KeyPurpose = 'SYNTHETIC_RUNTIME', keyId = `dev10-${purpose === 'SYNTHETIC_RUNTIME' ? 'synthetic' : 'runtime'}-key`): SyntheticTrust {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyHex = Buffer.from(spki.subarray(spki.length - 32)).toString('hex');
  const signer: RuntimeSigner = Object.freeze({ keyId, sign: async (m: Uint8Array) => new Uint8Array(nodeSign(null, Buffer.from(m), privateKey)) });
  const entry = { publicKeyHex, purpose, notBeforeMs: 0, notAfterMs: NOW * 100, revokedAtMs: null as number | null };
  return { signer, entry, keyRing: () => ({ [keyId]: entry }), keyId };
}
export interface RuntimeRig { readonly runtime: TrustedReadRuntime; readonly verifier: ReturnType<typeof createObservationVerifier>; readonly trust: SyntheticTrust }
/** The synthetic trusted runtime around a test transport, with its matching verifier. */
export function runtimeOver(transport: StripeReadTransport, gate: ReadGate, clock: () => number, trust: SyntheticTrust = syntheticTrust()): RuntimeRig {
  const runtime = createSyntheticTrustedRuntime({ signer: trust.signer, keyRing: trust.keyRing, gate, clock, transport });
  return { runtime, verifier: createObservationVerifier({ keyRing: trust.keyRing, clock }), trust };
}
/** The real-provider shape (account and invoice only) over a synthetic runtime. Replaces the pre-DEV-10 `createRealReadProvider({ transport, gate })`. */
export function providerOver(o: { transport: StripeReadTransport; gate: ReadGate; clock: () => number; audit: AuditSink; apiVersion?: string; trust?: SyntheticTrust }): RealReadProvider & { rig: RuntimeRig } {
  const rig = runtimeOver(o.transport, o.gate, o.clock, o.trust);
  return { ...createRealReadProvider({ runtime: rig.runtime, verifier: rig.verifier, clock: o.clock, audit: o.audit, ...(o.apiVersion !== undefined ? { apiVersion: o.apiVersion } : {}) }), rig };
}
export function adapterOver(o: { transport: StripeReadTransport; gate: ReadGate; expectedAccountId: string; clock: () => number; audit: AuditSink; apiVersion?: string; trust?: SyntheticTrust }): StripeReadOnlyEvidenceAdapter {
  const rig = runtimeOver(o.transport, o.gate, o.clock, o.trust);
  return new StripeReadOnlyEvidenceAdapter({ runtime: rig.runtime, verifier: rig.verifier, expectedAccountId: o.expectedAccountId, clock: o.clock, audit: o.audit, ...(o.apiVersion !== undefined ? { apiVersion: o.apiVersion } : {}) });
}
export function captureOver(d: { transport: StripeReadTransport; gate: ReadGate; store: ProofStore; clock: () => number; audit: AuditSink; apiVersion?: string; trust?: SyntheticTrust }, req: Parameters<typeof captureProof>[1]) {
  const rig = runtimeOver(d.transport, d.gate, d.clock, d.trust);
  return captureProof({ runtime: rig.runtime, verifier: rig.verifier, store: d.store, clock: d.clock, audit: d.audit, ...(d.apiVersion !== undefined ? { apiVersion: d.apiVersion } : {}) }, req);
}
