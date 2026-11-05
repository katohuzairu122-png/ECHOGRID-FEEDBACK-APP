import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/client';
import {
  benefitApplicationIntents, businessSubscriptions, partnerCreditReservations, partnerCreditSettlementAuthorizations, s08AllocationFreezeItems, s08AllocationFreezes,
} from '../db/schema';
import type { FrozenAggregateBenefitAllocation } from '../billing/aggregate-benefit-allocation';
import { classifySettlement, MOCK_EVIDENCE_KIND, SETTLEMENT_CLASSIFIER_VERSION, type MockSettlementEvidence, type SettlementClassifierContext } from '../billing/settlement-eligibility.classifier';

/**
 * S08-D1D3-DEV-03: the consumption SETTLEMENT GATE. INERT: the evidence table's insert guard and the 0041/0042 guards still deny every write outside an isolated
 * disposable database, and no route, queue or cron calls anything here.
 *
 * Three authorities stay separate. The pure classifier decides what verified evidence means. The RECORDER below persists that conclusion as append-only evidence;
 * it takes EVIDENCE only (never a verdict) and derives every expected value (tenant, invoice, customer, subscription, currency, frozen allocation, reservation expiry)
 * from persisted rows. The GATE runs inside the existing consumption transaction, under its locks, and re-validates the newest stored authorization against the
 * persisted reservation, intent and freeze and against the configuration, using the DATABASE clock. Nothing a caller passes can make either of them say "eligible".
 *
 * Configuration (not policy): the expected Stripe account and mode, the freshness window, the allowed billing intervals and the accepted evidence kinds. There are no
 * defaults: an unset, null or malformed value makes the gate refuse. Monthly-only is a RESTRICTIVE DEVELOPMENT DEFAULT that a caller must pass explicitly; it is not
 * an approved permanent policy. The effective instant of PC-BENEFIT/1 is unresolved (Q14) and is only ever supplied by configuration.
 */
export const SETTLEMENT_AUTH_LABEL = 'ECHO-GRID:S08-SETTLEMENT-AUTH/1' as const;
/** A restrictive development default, to be passed explicitly by a caller. Not an approved permanent policy (Q12). */
export const DEVELOPMENT_ALLOWED_INTERVALS: readonly ('month' | 'year')[] = Object.freeze(['month'] as const);

export interface SettlementGateConfig {
  readonly providerAccountId: string;
  readonly providerMode: 'test' | 'live';
  /** Maximum age of the newest authorization at consumption time. No default: null, undefined or a malformed value refuses everything. */
  readonly freshnessWindowMs: number | null;
  /** Instant from which PC-BENEFIT/1 applies to invoices (Q14, unresolved). Used by the recorder; null makes the classifier return UNRESOLVED. */
  readonly policyEffectiveFromMs: number | null;
  readonly allowedIntervals: readonly ('month' | 'year')[];
  readonly acceptedEvidenceKinds: readonly string[];
}

export type SettlementGateReason =
  | 'GATE_UNCONFIGURED' | 'AUTHORIZATION_MISSING' | 'NOT_ELIGIBLE' | 'INTEGRITY_MISMATCH' | 'BINDING_MISMATCH' | 'PROVIDER_SCOPE_MISMATCH' | 'POLICY_MISMATCH'
  | 'EVIDENCE_KIND_NOT_ACCEPTED' | 'INTERVAL_NOT_ENABLED' | 'ALLOCATION_MISMATCH' | 'EVIDENCE_FROM_FUTURE' | 'STALE_EVIDENCE';

export class SettlementGateError extends Error {
  readonly financialAuthority = false as const;
  constructor(readonly reason: SettlementGateReason) { super(`PARTNER_CONSUME_SETTLEMENT_NOT_AUTHORIZED (${reason})`); this.name = 'SettlementGateError'; }
}

const isNonNegInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const REF = /^[!-~]{1,255}$/;

export function validSettlementGateConfig(c: SettlementGateConfig | undefined | null): c is SettlementGateConfig {
  return !!c && typeof c.providerAccountId === 'string' && REF.test(c.providerAccountId) && (c.providerMode === 'test' || c.providerMode === 'live') && isNonNegInt(c.freshnessWindowMs)
    && Array.isArray(c.allowedIntervals) && c.allowedIntervals.length > 0 && c.allowedIntervals.every(i => i === 'month' || i === 'year')
    && Array.isArray(c.acceptedEvidenceKinds) && c.acceptedEvidenceKinds.length > 0 && c.acceptedEvidenceKinds.every(k => typeof k === 'string' && k.length > 0);
}

export interface AuthorizationDigestFields {
  businessId: string; reservationId: string; decisionId: string; invoiceRef: string; providerAccountId: string; providerMode: string; allocationDigest: string; policyVersion: string;
  verdict: string; reasonCodes: readonly string[]; classifierVersion: string; evidenceKind: string; billingInterval: string; snapshotRef: string; snapshotDigest: string; observedAtMs: number;
}

/** The canonical digest, identical to `partner_credit_settlement_auth_digest` in migration 0060 (length-prefixed fields, printable ASCII only). */
export async function settlementAuthorizationDigest(f: AuthorizationDigestFields): Promise<string> {
  const parts = [SETTLEMENT_AUTH_LABEL, f.businessId, f.reservationId, f.decisionId, f.invoiceRef, f.providerAccountId, f.providerMode, f.allocationDigest, f.policyVersion, f.verdict,
    f.reasonCodes.join(','), f.classifierVersion, f.evidenceKind, f.billingInterval, f.snapshotRef, f.snapshotDigest, String(f.observedAtMs)];
  const bytes = new TextEncoder().encode(parts.map(v => `${v.length}:${v};`).join(''));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

const dbNowMs = async (tx: Transaction): Promise<number> => {
  const r = await tx.execute(sql`select (extract(epoch from clock_timestamp()) * 1000)::bigint as ms`);
  return Number((r.rows[0] as { ms: string | number }).ms);
};

export class SettlementAuthorizationError extends Error {
  constructor(readonly code: 'UNKNOWN_RESERVATION' | 'INTENT_MISSING' | 'ALLOCATION_MISSING' | 'SUBSCRIPTION_MISSING' | 'EVIDENCE_UNUSABLE' | 'REPLAY_CONFLICT' | 'CONFIG_INVALID') {
    super(`SETTLEMENT_AUTH_${code}`); this.name = 'SettlementAuthorizationError';
  }
}

/**
 * Records the classifier's conclusion for one reservation. Takes EVIDENCE only. Locks only the reservation (so it serialises with the consumption transaction, which
 * holds that lock last in its own lock order, and cannot deadlock with it). Idempotent per (reservation, snapshot digest).
 */
export class SettlementAuthorizationRecorder {
  constructor(private readonly db: Database, private readonly config: SettlementGateConfig) {}

  async record(input: { reservationId: string; businessId: string; evidence: MockSettlementEvidence }): Promise<{ id: string; verdict: 'ELIGIBLE' | 'INELIGIBLE' | 'UNRESOLVED'; reasonCodes: readonly string[]; replay: boolean }> {
    const cfg = this.config;
    if (!validSettlementGateConfig(cfg)) throw new SettlementAuthorizationError('CONFIG_INVALID');
    return this.db.transaction(async tx => {
      const [reservation] = await tx.select().from(partnerCreditReservations)
        .where(and(eq(partnerCreditReservations.id, input.reservationId), eq(partnerCreditReservations.businessId, input.businessId))).for('update');
      if (!reservation) throw new SettlementAuthorizationError('UNKNOWN_RESERVATION');
      const [intent] = await tx.select().from(benefitApplicationIntents)
        .where(and(eq(benefitApplicationIntents.reservationId, reservation.id), eq(benefitApplicationIntents.businessId, input.businessId))).limit(1);
      if (!intent) throw new SettlementAuthorizationError('INTENT_MISSING');
      const [freeze] = await tx.select().from(s08AllocationFreezes)
        .where(and(eq(s08AllocationFreezes.businessId, input.businessId), eq(s08AllocationFreezes.invoiceRef, intent.invoiceRef))).limit(1);
      const frozen = freeze?.artifact as unknown as FrozenAggregateBenefitAllocation | undefined;
      if (!freeze || !frozen || frozen.allocationDigest !== freeze.allocationDigest) throw new SettlementAuthorizationError('ALLOCATION_MISSING');
      const [item] = await tx.select({ id: s08AllocationFreezeItems.freezeId }).from(s08AllocationFreezeItems)
        .where(and(eq(s08AllocationFreezeItems.freezeId, freeze.id), eq(s08AllocationFreezeItems.reservationId, reservation.id))).limit(1);
      if (!item) throw new SettlementAuthorizationError('ALLOCATION_MISSING');
      const subscriptions = await tx.select().from(businessSubscriptions).where(and(eq(businessSubscriptions.businessId, input.businessId), eq(businessSubscriptions.status, 'active')));
      const sub = subscriptions.length === 1 ? subscriptions[0]! : undefined;
      if (!sub || !sub.stripeCustomerId || !sub.stripeSubscriptionId) throw new SettlementAuthorizationError('SUBSCRIPTION_MISSING');

      const nowMs = await dbNowMs(tx);
      const ctx: SettlementClassifierContext = {
        nowMs,
        policy: { version: intent.policyVersion, effectiveFromMs: cfg.policyEffectiveFromMs, freshnessWindowMs: cfg.freshnessWindowMs },
        expected: {
          businessId: input.businessId, reservationId: reservation.id, intentRef: reservation.invoiceIntentRef, invoiceRef: intent.invoiceRef,
          customerRef: sub.stripeCustomerId, subscriptionRef: sub.stripeSubscriptionId, currency: intent.currency,
          providerAccountId: cfg.providerAccountId, providerMode: cfg.providerMode, reservationExpiresAtMs: reservation.expiresAt.getTime(), frozenAllocation: frozen,
        },
      };
      const result = classifySettlement(ctx, input.evidence);
      const observedAtMs = input.evidence?.provenance?.observedAtMs;
      const interval = input.evidence?.invoice?.billingInterval;
      if (!result.evidenceRefs.snapshotRef || !result.evidenceRefs.snapshotDigest || !isNonNegInt(observedAtMs) || observedAtMs <= 0 || input.evidence.provenance.evidenceKind !== MOCK_EVIDENCE_KIND)
        throw new SettlementAuthorizationError('EVIDENCE_UNUSABLE'); // evidence that cannot even be identified leaves no row; the gate then sees "missing"
      const fields: AuthorizationDigestFields = {
        businessId: input.businessId, reservationId: reservation.id, decisionId: reservation.decisionId, invoiceRef: intent.invoiceRef, providerAccountId: cfg.providerAccountId, providerMode: cfg.providerMode,
        allocationDigest: freeze.allocationDigest, policyVersion: intent.policyVersion, verdict: result.verdict, reasonCodes: result.reasonCodes, classifierVersion: result.classifierVersion,
        evidenceKind: MOCK_EVIDENCE_KIND, billingInterval: interval === 'month' || interval === 'year' ? interval : 'unknown', snapshotRef: result.evidenceRefs.snapshotRef,
        snapshotDigest: result.evidenceRefs.snapshotDigest, observedAtMs,
      };
      const evidenceDigest = await settlementAuthorizationDigest(fields);
      const inserted = await tx.insert(partnerCreditSettlementAuthorizations).values({
        businessId: fields.businessId, reservationId: fields.reservationId, decisionId: fields.decisionId, invoiceRef: fields.invoiceRef, providerAccountId: fields.providerAccountId,
        providerMode: cfg.providerMode, allocationDigest: fields.allocationDigest, policyVersion: fields.policyVersion, verdict: result.verdict, reasonCodes: [...result.reasonCodes],
        classifierVersion: fields.classifierVersion, evidenceKind: fields.evidenceKind, billingInterval: fields.billingInterval as 'month' | 'year' | 'unknown', snapshotRef: fields.snapshotRef,
        snapshotDigest: fields.snapshotDigest, observedAtMs, evidenceDigest,
      }).onConflictDoNothing({ target: [partnerCreditSettlementAuthorizations.reservationId, partnerCreditSettlementAuthorizations.snapshotDigest] }).returning({ id: partnerCreditSettlementAuthorizations.id });
      if (inserted[0]) return { id: inserted[0].id, verdict: result.verdict, reasonCodes: result.reasonCodes, replay: false };
      const [existing] = await tx.select().from(partnerCreditSettlementAuthorizations)
        .where(and(eq(partnerCreditSettlementAuthorizations.reservationId, reservation.id), eq(partnerCreditSettlementAuthorizations.snapshotDigest, fields.snapshotDigest))).limit(1);
      if (!existing || existing.evidenceDigest !== evidenceDigest) throw new SettlementAuthorizationError('REPLAY_CONFLICT'); // same snapshot, different conclusion: never silently replaced
      return { id: existing.id, verdict: existing.verdict, reasonCodes: existing.reasonCodes, replay: true };
    });
  }
}

/**
 * The gate. Called INSIDE the consumption transaction after the settlement, decision, lot, account and reservation are locked and after the application, intent and
 * every existing consumption check passed, and BEFORE any write. Everything is re-read here; nothing is taken from the caller. Throws SettlementGateError (no write
 * has happened yet, so the whole transaction leaves no trace).
 */
export async function requireSettlementAuthorization(
  tx: Transaction,
  ctx: { businessId: string; reservationId: string; decisionId: string; invoiceRef: string; policyVersion: string },
  config: SettlementGateConfig | undefined,
): Promise<void> {
  if (!validSettlementGateConfig(config)) throw new SettlementGateError('GATE_UNCONFIGURED');
  const [row] = await tx.select().from(partnerCreditSettlementAuthorizations)
    .where(and(eq(partnerCreditSettlementAuthorizations.reservationId, ctx.reservationId), eq(partnerCreditSettlementAuthorizations.businessId, ctx.businessId)))
    .orderBy(desc(partnerCreditSettlementAuthorizations.observedAtMs), desc(partnerCreditSettlementAuthorizations.recordedAt), desc(partnerCreditSettlementAuthorizations.id)).limit(1);
  if (!row) throw new SettlementGateError('AUTHORIZATION_MISSING');
  if (row.verdict !== 'ELIGIBLE') throw new SettlementGateError('NOT_ELIGIBLE'); // the newest snapshot governs: a later non-eligible one revokes an earlier eligible one
  const expectedDigest = await settlementAuthorizationDigest({ ...row, reasonCodes: row.reasonCodes });
  if (row.evidenceDigest !== expectedDigest) throw new SettlementGateError('INTEGRITY_MISMATCH');
  if (row.businessId !== ctx.businessId || row.reservationId !== ctx.reservationId || row.decisionId !== ctx.decisionId || row.invoiceRef !== ctx.invoiceRef) throw new SettlementGateError('BINDING_MISMATCH');
  if (row.providerAccountId !== config.providerAccountId || row.providerMode !== config.providerMode) throw new SettlementGateError('PROVIDER_SCOPE_MISMATCH');
  if (row.policyVersion !== ctx.policyVersion || row.classifierVersion !== SETTLEMENT_CLASSIFIER_VERSION) throw new SettlementGateError('POLICY_MISMATCH');
  if (!config.acceptedEvidenceKinds.includes(row.evidenceKind)) throw new SettlementGateError('EVIDENCE_KIND_NOT_ACCEPTED');
  if (row.billingInterval === 'unknown' || !config.allowedIntervals.includes(row.billingInterval)) throw new SettlementGateError('INTERVAL_NOT_ENABLED');
  // the persisted freeze must still be the one the evidence was classified against, and must still contain this reservation
  const [freeze] = await tx.select({ id: s08AllocationFreezes.id, digest: s08AllocationFreezes.allocationDigest }).from(s08AllocationFreezes)
    .where(and(eq(s08AllocationFreezes.businessId, ctx.businessId), eq(s08AllocationFreezes.invoiceRef, ctx.invoiceRef))).limit(1);
  if (!freeze || freeze.digest !== row.allocationDigest) throw new SettlementGateError('ALLOCATION_MISMATCH');
  const [item] = await tx.select({ id: s08AllocationFreezeItems.freezeId }).from(s08AllocationFreezeItems)
    .where(and(eq(s08AllocationFreezeItems.freezeId, freeze.id), eq(s08AllocationFreezeItems.reservationId, ctx.reservationId))).limit(1);
  if (!item) throw new SettlementGateError('ALLOCATION_MISMATCH');
  const age = (await dbNowMs(tx)) - Number(row.observedAtMs); // the DATABASE clock, read inside the transaction: no caller-supplied time
  if (age < 0) throw new SettlementGateError('EVIDENCE_FROM_FUTURE');
  if (age > (config.freshnessWindowMs as number)) throw new SettlementGateError('STALE_EVIDENCE');
}
