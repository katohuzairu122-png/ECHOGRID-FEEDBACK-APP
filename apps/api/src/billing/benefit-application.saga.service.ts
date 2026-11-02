import { and, asc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  benefitApplicationCompensations, benefitApplicationIntents, benefitApplicationTransitions, benefitProviderAttempts, benefitProviderObservations,
  partnerCreditReservations,
} from '../db/schema';
import {
  classifyPresentEffect, startApplication, transition,
  type ApplicationBase, type ApplicationEffect, type ApplicationEvent, type ApplicationState, type ProviderObservation, type RejectCode, type RetainCause,
} from './invoice-benefit-application.saga';
import { verifyStoredAllocationEvidence, type StoredAllocationParent, type StoredAllocationItem } from './stored-allocation-verifier';

/**
 * Split 08 durable benefit-application saga service (migration 0048). INERT: the saga tables are write-denied by their own guard (like 0042) in every
 * ordinary database, so this service only runs where the guard has been disabled on an isolated disposable database.
 *
 * It persists the PURE state machine in invoice-benefit-application.saga.ts: every call locks the intent row, loads the state, asks the pure
 * `transition`, and writes the new state, the provider attempt, the append-only observation and compensation rows and an append-only transition log in
 * ONE transaction. It never moves a lot, an account, the ledger or a reservation and never calls a provider: a `consumed` saga means a verified provider
 * effect was reconciled; the terminal credit-consumption transaction is a separate stage that is not authorized.
 */
export type IntentView = {
  id: string; businessId: string; reservationId: string; invoiceRef: string; units: number; expectedBenefitMinor: number; currency: string; policyVersion: string;
  state: ApplicationState['kind']; outcome: 'pending' | 'confirmed' | 'rejected' | 'disputed' | 'unresolved'; attemptKey: string | null; cause: string | null;
  providerEffectRef: string | null; version: number;
};

export type SagaResult =
  | { ok: true; intent: IntentView; effects: ApplicationEffect[]; replay: boolean }
  | { ok: false; code: RejectCode | 'NOT_FOUND' | 'ALLOCATION_REQUIRED' | 'ALLOCATION_MISMATCH'; intent: IntentView | null };

export class BenefitSagaError extends Error {
  constructor(public readonly code: 'RESERVATION_NOT_FOUND' | 'RESERVATION_NOT_RESERVED' | 'RESERVATION_EXPIRED' | 'INTENT_CONFLICT' | 'INVALID_INPUT') {
    super(`Benefit saga: ${code}`);
    this.name = 'BenefitSagaError';
  }
}

type Row = typeof benefitApplicationIntents.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const DISPUTED: ReadonlySet<RetainCause> = new Set(['PROVIDER_EFFECT_MISMATCH', 'PROVIDER_EFFECT_UNATTRIBUTED', 'REVERSAL_DURING_APPLICATION']);

export function outcomeOf(s: ApplicationState): IntentView['outcome'] {
  if (s.kind === 'consumed') return 'confirmed';
  if (s.kind === 'released') return 'rejected';
  if (s.kind === 'retained') return DISPUTED.has(s.cause) ? 'disputed' : 'unresolved';
  return 'pending';
}

const view = (r: Row): IntentView => ({
  id: r.id, businessId: r.businessId, reservationId: r.reservationId, invoiceRef: r.invoiceRef, units: r.units, expectedBenefitMinor: r.expectedBenefitMinor,
  currency: r.currency, policyVersion: r.policyVersion, state: r.state, outcome: r.outcome, attemptKey: r.attemptKey, cause: r.cause, providerEffectRef: r.providerEffectRef, version: r.version,
});

async function digest(o: ProviderObservation): Promise<string> {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const baseOf = (r: Row): ApplicationBase => ({
  reservationRef: r.reservationId, businessId: r.businessId, invoiceRef: r.invoiceRef, units: r.units, expectedBenefitMinor: r.expectedBenefitMinor, currency: r.currency, policyVersion: r.policyVersion,
});

async function stateOf(tx: Tx, r: Row): Promise<ApplicationState> {
  const base = baseOf(r);
  switch (r.state) {
    case 'reserved': return { kind: 'reserved', ...base };
    case 'applying': return { kind: 'applying', ...base, attemptKey: r.attemptKey!, attemptedAt: r.attemptedAt!.getTime() };
    case 'retained': return { kind: 'retained', ...base, attemptKey: r.attemptKey!, attemptedAt: r.attemptedAt!.getTime(), cause: r.cause as RetainCause, pendingReversalRefs: r.pendingReversalRefs };
    case 'released': return { kind: 'released', ...base, cause: r.cause as never };
    case 'consumed': {
      const comps = await tx.select({ ref: benefitApplicationCompensations.reversalRef }).from(benefitApplicationCompensations).where(eq(benefitApplicationCompensations.intentId, r.id));
      return { kind: 'consumed', ...base, providerEffectRef: r.providerEffectRef!, appliedAt: r.appliedAt!.getTime(), compensations: comps.map(c => c.ref) };
    }
  }
}

export class BenefitApplicationSagaService {
  constructor(private readonly db: Database) {}

  /** Candidate storage is NOT migrated/activated. Preserve the pre-existing
   * inert saga where neither table exists. Once installed, every new attempt
   * requires the complete frozen envelope; partial installation fails closed.
   * Reservation lock is held by the caller across this check and the attempt. */
  private async allocationGate(tx: Tx, row: Row, invoiceIntentRef: string): Promise<'ALLOCATION_REQUIRED' | 'ALLOCATION_MISMATCH' | null> {
    const presence = await tx.execute(sql`SELECT
      to_regclass('s08_allocation_freezes') IS NOT NULL AS parent,
      to_regclass('s08_allocation_freeze_items') IS NOT NULL AS child`);
    const tables = presence.rows[0];
    if (tables?.parent === false && tables?.child === false) return null;
    if (tables?.parent !== true || tables?.child !== true) return 'ALLOCATION_REQUIRED';
    const parents = await tx.execute(sql`SELECT f.* FROM s08_allocation_freezes f
      JOIN s08_allocation_freeze_items i ON i.freeze_id=f.id AND i.business_id=f.business_id
      WHERE i.reservation_id=${row.reservationId} AND f.business_id=${row.businessId}`);
    const parent = parents.rows[0] as unknown as StoredAllocationParent | undefined;
    if (!parent || parents.rows.length !== 1) return 'ALLOCATION_REQUIRED';
    const children = await tx.execute(sql`SELECT * FROM s08_allocation_freeze_items
      WHERE freeze_id=${parent.id} ORDER BY reservation_id`);
    const verified = await verifyStoredAllocationEvidence(parent, children.rows as unknown as StoredAllocationItem[]);
    if (verified.status !== 'verified_snapshot') return 'ALLOCATION_MISMATCH';
    const artifact = verified.artifact;
    const allocation = artifact.allocations.find(a => a.reservationId === row.reservationId);
    if (!allocation || artifact.businessId !== row.businessId || artifact.invoiceRef !== row.invoiceRef ||
        artifact.currency !== row.currency || artifact.benefitPolicyVersion !== row.policyVersion ||
        allocation.units !== row.units || allocation.benefitMinor !== row.expectedBenefitMinor ||
        allocation.invoiceIntentRef !== invoiceIntentRef) return 'ALLOCATION_MISMATCH';
    return null;
  }

  /** Idempotent: re-creating the intent for the same reservation with the same terms returns it; different terms are refused. */
  async createIntent(input: { reservationId: string; invoiceRef: string; expectedBenefitMinor: number; currency: string; policyVersion: string }, now = new Date()): Promise<IntentView> {
    return this.db.transaction(async tx => {
      const [res] = await tx.select().from(partnerCreditReservations).where(eq(partnerCreditReservations.id, input.reservationId)).for('share');
      if (!res) throw new BenefitSagaError('RESERVATION_NOT_FOUND');
      if (res.state !== 'reserved') throw new BenefitSagaError('RESERVATION_NOT_RESERVED');
      if (res.expiresAt.getTime() <= now.getTime()) throw new BenefitSagaError('RESERVATION_EXPIRED');
      try {
        startApplication({ reservationRef: res.id, businessId: res.businessId, invoiceRef: input.invoiceRef, units: res.units, expectedBenefitMinor: input.expectedBenefitMinor, currency: input.currency, policyVersion: input.policyVersion });
      } catch { throw new BenefitSagaError('INVALID_INPUT'); }
      await tx.insert(benefitApplicationIntents).values({
        businessId: res.businessId, reservationId: res.id, invoiceRef: input.invoiceRef, units: res.units, expectedBenefitMinor: input.expectedBenefitMinor,
        currency: input.currency, policyVersion: input.policyVersion,
      }).onConflictDoNothing({ target: benefitApplicationIntents.reservationId });
      const [row] = await tx.select().from(benefitApplicationIntents).where(eq(benefitApplicationIntents.reservationId, res.id));
      if (!row) throw new BenefitSagaError('INVALID_INPUT');
      if (row.invoiceRef !== input.invoiceRef || row.expectedBenefitMinor !== input.expectedBenefitMinor || row.currency !== input.currency || row.policyVersion !== input.policyVersion)
        throw new BenefitSagaError('INTENT_CONFLICT');
      return view(row);
    });
  }

  async get(intentId: string): Promise<IntentView | null> {
    const [row] = await this.db.select().from(benefitApplicationIntents).where(eq(benefitApplicationIntents.id, intentId));
    return row ? view(row) : null;
  }

  beginApply(intentId: string, attemptKey: string, now = new Date()): Promise<SagaResult> {
    return this.run(intentId, { type: 'begin_apply', attemptKey, at: now.getTime() });
  }

  recordObservation(intentId: string, attemptKey: string, observation: ProviderObservation, now = new Date()): Promise<SagaResult> {
    return this.run(intentId, { type: 'provider_observation', attemptKey, observation, at: now.getTime() });
  }

  reverse(intentId: string, reversalRef: string, now = new Date()): Promise<SagaResult> {
    return this.run(intentId, { type: 'reverse', reversalRef, at: now.getTime() });
  }

  releaseUnused(intentId: string, now = new Date()): Promise<SagaResult> {
    return this.run(intentId, { type: 'release_unused', at: now.getTime() });
  }

  /** Crash recovery: attempts that were started (or are held) and have not moved since `olderThan`, oldest first, for a reconciler to re-query. */
  async findUnresolved(olderThan: Date, limit = 50): Promise<IntentView[]> {
    const rows = await this.db.select().from(benefitApplicationIntents)
      .where(and(inArray(benefitApplicationIntents.state, ['applying', 'retained']), lt(benefitApplicationIntents.updatedAt, olderThan)))
      .orderBy(asc(benefitApplicationIntents.updatedAt)).limit(Math.min(Math.max(limit, 1), 500));
    return rows.map(view);
  }

  /**
   * Two sagas confirming the same provider effect at the same instant can both pass the in-transaction pre-check; the partial unique index on
   * provider_effect_ref then rejects the loser. That is the database backstop working, so the loser is simply re-run once: its pre-check now sees the
   * winner and treats the effect as unattributed (retained for reconciliation) instead of failing.
   */
  private async run(intentId: string, event: ApplicationEvent): Promise<SagaResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.runOnce(intentId, event);
      } catch (e) {
        const cause = (e as { cause?: { code?: string; constraint?: string } }).cause ?? (e as { code?: string; constraint?: string });
        if (attempt < 2 && cause.code === '23505' && cause.constraint === 'benefit_application_intents_effect_key') continue;
        throw e;
      }
    }
  }

  private runOnce(intentId: string, event: ApplicationEvent): Promise<SagaResult> {
    return this.db.transaction(async tx => {
      // Shared order with allocation freezing: reservation first, then intent.
      // Never lock the intent before waiting for its reservation. The initial
      // read resolves identity only; it is checked again after both locks.
      let reservation: typeof partnerCreditReservations.$inferSelect | undefined;
      if (event.type === 'begin_apply') {
        const [identity] = await tx.select({ reservationId: benefitApplicationIntents.reservationId })
          .from(benefitApplicationIntents).where(eq(benefitApplicationIntents.id, intentId));
        if (!identity) return { ok: false, code: 'NOT_FOUND', intent: null } as const;
        [reservation] = await tx.select().from(partnerCreditReservations)
          .where(eq(partnerCreditReservations.id, identity.reservationId)).for('update');
      }
      const [row] = await tx.select().from(benefitApplicationIntents).where(eq(benefitApplicationIntents.id, intentId)).for('update');
      if (!row) return { ok: false, code: 'NOT_FOUND', intent: null } as const;
      if (event.type === 'begin_apply' && (!reservation || reservation.id !== row.reservationId || reservation.businessId !== row.businessId))
        return { ok: false, code: 'NOT_FOUND', intent: null } as const;
      const before = await stateOf(tx, row);
      let ev = event;
      if (ev.type === 'provider_observation' && ev.observation?.status === 'effect_present' && before.kind !== 'consumed' && before.kind !== 'released' && typeof ev.observation.effectRef === 'string') {
        // One provider effect can settle exactly one reservation: an effect already bound to another intent is treated as unattributed here.
        const [other] = await tx.select({ id: benefitApplicationIntents.id }).from(benefitApplicationIntents)
          .where(and(eq(benefitApplicationIntents.providerEffectRef, ev.observation.effectRef), ne(benefitApplicationIntents.id, intentId))).limit(1);
        if (other) ev = { ...ev, observation: { ...ev.observation, attributedToReservationRef: null } };
      }
      const r = transition(before, ev);
      if (!r.ok) return { ok: false, code: r.code, intent: view(row) } as const;

      if (ev.type === 'begin_apply' && !r.replay) {
        if (!reservation || reservation.state !== 'reserved') throw new BenefitSagaError('RESERVATION_NOT_RESERVED');
        const gate = await this.allocationGate(tx, row, reservation.invoiceIntentRef);
        if (gate) return { ok: false, code: gate, intent: view(row) } as const;
      }

      let next: Row = row;
      if (!r.replay) {
        const s = r.state;
        const set: Partial<typeof benefitApplicationIntents.$inferInsert> = {
          state: s.kind, outcome: outcomeOf(s), version: sql`${benefitApplicationIntents.version} + 1` as never, updatedAt: new Date(),
          cause: s.kind === 'retained' || s.kind === 'released' ? s.cause : null,
          pendingReversalRefs: s.kind === 'retained' ? [...s.pendingReversalRefs] : [],
          providerEffectRef: s.kind === 'consumed' ? s.providerEffectRef : null,
          appliedAt: s.kind === 'consumed' ? new Date(s.appliedAt) : null,
        };
        if (s.kind === 'applying' || s.kind === 'retained') { set.attemptKey = s.attemptKey; set.attemptedAt = new Date(s.attemptedAt); }
        const [updated] = await tx.update(benefitApplicationIntents).set(set).where(eq(benefitApplicationIntents.id, intentId)).returning();
        next = updated!;
      }

      if (ev.type === 'begin_apply' && !r.replay) {
        await tx.insert(benefitProviderAttempts).values({
          intentId, businessId: row.businessId, attemptKey: ev.attemptKey, providerIdempotencyKey: `benefit-apply:v1:${row.reservationId}`, startedAt: new Date(ev.at),
        });
      }
      if (ev.type === 'provider_observation' && before.kind !== 'reserved') {
        const o = ev.observation;
        const attemptedAt = before.kind === 'applying' || before.kind === 'retained' ? before.attemptedAt : 0;
        const classification = o.status === 'unreachable' ? 'unreachable'
          : o.status === 'effect_absent' ? (o.checkedAt >= attemptedAt ? 'absent_confirmed' : 'absent_stale')
            : classifyPresentEffect(baseOf(row), o);
        await tx.insert(benefitProviderObservations).values({
          intentId, businessId: row.businessId, attemptKey: ev.attemptKey, status: o.status, classification,
          effectRef: o.status === 'effect_present' ? o.effectRef : null, amountMinor: o.status === 'effect_present' ? o.amountMinor : null,
          currency: o.status === 'effect_present' ? o.currency : null, invoiceRef: o.status === 'effect_present' ? o.invoiceRef : null,
          attributedReservationRef: o.status === 'effect_present' ? o.attributedToReservationRef : null,
          checkedAt: new Date(o.status === 'effect_absent' ? o.checkedAt : ev.at), payloadDigest: await digest(o),
        }).onConflictDoNothing({ target: [benefitProviderObservations.intentId, benefitProviderObservations.attemptKey, benefitProviderObservations.payloadDigest] });
      }
      for (const e of r.effects) {
        if (e.type !== 'append_compensation') continue;
        await tx.insert(benefitApplicationCompensations).values({
          intentId, businessId: row.businessId, reversalRef: e.reversalRef, units: e.units, benefitMinor: e.benefitMinor, idempotencyKey: e.idempotencyKey,
        }).onConflictDoNothing({ target: [benefitApplicationCompensations.intentId, benefitApplicationCompensations.reversalRef] });
      }
      await tx.insert(benefitApplicationTransitions).values({
        intentId, businessId: row.businessId, eventType: ev.type, fromState: before.kind, toState: r.state.kind, replay: r.replay,
        attemptKey: 'attemptKey' in ev ? ev.attemptKey : null, effects: r.effects as unknown as Record<string, unknown>[], occurredAt: new Date(ev.at),
      });
      // New attempts, unlike reconciliation/replay of an existing obligation,
      // must still be unexpired at the last locked server-clock check.
      if (ev.type === 'begin_apply' && !r.replay) {
        const expired = await tx.execute(sql`SELECT id FROM partner_credit_reservations
          WHERE id=${row.reservationId} AND expires_at <= clock_timestamp()`);
        if (expired.rows.length) throw new BenefitSagaError('RESERVATION_EXPIRED');
      }
      return { ok: true, intent: view(next), effects: r.effects, replay: r.replay } as const;
    });
  }
}
