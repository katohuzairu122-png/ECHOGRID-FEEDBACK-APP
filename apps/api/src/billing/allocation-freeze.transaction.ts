import type { PoolClient } from 'pg';
import {
  freezeAggregateBenefitAllocation,
  type AggregateAllocationInput,
  type FrozenAggregateBenefitAllocation,
} from './aggregate-benefit-allocation';
import { verifyStoredAllocationSnapshot } from './stored-allocation-verifier';

/**
 * S08-DEV-06 development-only guarded atomic writer. Requires the candidate
 * schema to exist and its INERT triggers to be disabled ONLY in a disposable
 * test database. Never disable a guard here, grant rights or call Stripe.
 *
 * Authentication of the invoice and actual draft state is NOT provided by the
 * existing schema. Therefore this writer is NOT a financial-authority gate.
 */
export class AllocationFreezeConflict extends Error {
  constructor(
    readonly reason: 'RESERVATION_MISMATCH' | 'CONFLICTING_FREEZE' | 'VERIFICATION_FAILED',
  ) {
    super('Allocation freeze: ' + reason);
  }
}

export interface StoredAllocationFreeze {
  readonly id: string;
  readonly artifact: FrozenAggregateBenefitAllocation;
  readonly replay: boolean;
  readonly providerVerified: false;
  readonly consumptionAuthorized: false;
}

/**
 * Caller owns the connection; no network call other than PostgreSQL is made.
 * The database-enforced INERT triggers make this refuse writes outside fixtures.
 * Locks all reservation rows in canonical order and freezes the entire batch
 * in one transaction; a rollback preserves zero writes.
 */
export async function freezeAllocationTransaction(
  client: Pick<PoolClient, 'query'>,
  input: AggregateAllocationInput,
): Promise<StoredAllocationFreeze> {
  const candidate = await freezeAggregateBenefitAllocation(input);
  await client.query('BEGIN');
  try {
    const ids = candidate.allocations.map((a) => a.reservationId);
    const reservations = await client.query<{
      id: string;
      business_id: string;
      invoice_intent_ref: string;
      state: string;
      units: number;
      expires: boolean;
    }>(
      `SELECT id, business_id, invoice_intent_ref, state, units,
              expires_at <= clock_timestamp() AS expires
       FROM partner_credit_reservations
       WHERE id = ANY($1::uuid[])
       ORDER BY id FOR UPDATE`,
      [ids],
    );
    if (
      reservations.rows.length !== ids.length ||
      reservations.rows.some((row, i) => {
        const allocation = candidate.allocations[i];
        return (
          !allocation ||
          row.id !== ids[i] ||
          row.business_id !== candidate.businessId ||
          row.invoice_intent_ref !== allocation.invoiceIntentRef ||
          row.state !== 'reserved' ||
          row.units !== 1 ||
          row.expires
        );
      })
    ) {
      throw new AllocationFreezeConflict('RESERVATION_MISMATCH');
    }

    // A caller-supplied providerAttemptStarted=false is never sufficient.
    // Refuse a freeze if ANY reservation in this batch already has a persisted
    // provider attempt, even if an intent's state has subsequently changed.
    const attempts = await client.query<{ reservation_id: string }>(
      `SELECT DISTINCT i.reservation_id
       FROM benefit_application_intents i
       JOIN benefit_provider_attempts a ON a.intent_id = i.id
       WHERE i.reservation_id = ANY($1::uuid[])
       LIMIT 1`,
      [ids],
    );
    if (attempts.rows.length > 0) {
      throw new AllocationFreezeConflict('RESERVATION_MISMATCH');
    }

    // Invoice identity is fixed in the artifact; the surrounding trusted
    // application must separately verify live provider invoice authority.
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO s08_allocation_freezes
       (business_id, invoice_ref, currency, policy_version, allocation_digest,
        aggregate_benefit_minor, reservation_count, artifact)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (business_id, invoice_ref) DO NOTHING RETURNING id`,
      [
        candidate.businessId,
        candidate.invoiceRef,
        candidate.currency,
        candidate.allocationPolicyVersion,
        candidate.allocationDigest,
        candidate.aggregateBenefitMinor,
        candidate.allocations.length,
        JSON.stringify(candidate),
      ],
    );
    let id = inserted.rows[0]?.id;
    if (id) {
      for (const allocation of candidate.allocations) {
        await client.query(
          `INSERT INTO s08_allocation_freeze_items
           (freeze_id, business_id, reservation_id, invoice_intent_ref, benefit_minor, provider_idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            id,
            candidate.businessId,
            allocation.reservationId,
            allocation.invoiceIntentRef,
            allocation.benefitMinor,
            allocation.providerIdempotencyKey,
          ],
        );
      }
    } else {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM s08_allocation_freezes WHERE business_id=$1 AND invoice_ref=$2 FOR UPDATE`,
        [candidate.businessId, candidate.invoiceRef],
      );
      id = existing.rows[0]?.id;
      if (!id) throw new AllocationFreezeConflict('CONFLICTING_FREEZE');
    }

    const saved = await client.query<{
      artifact: unknown;
      allocation_digest: string;
      reservation_count: number;
    }>(
      `SELECT artifact, allocation_digest, reservation_count FROM s08_allocation_freezes WHERE id=$1`,
      [id],
    );
    const row = saved.rows[0];
    if (
      !row ||
      row.allocation_digest !== candidate.allocationDigest ||
      row.reservation_count !== candidate.allocations.length
    ) {
      throw new AllocationFreezeConflict('CONFLICTING_FREEZE');
    }
    const verified = await verifyStoredAllocationSnapshot(row.artifact, input);
    if (verified.status !== 'verified_snapshot') {
      throw new AllocationFreezeConflict('CONFLICTING_FREEZE');
    }
    const items = await client.query<{
      reservation_id: string;
      invoice_intent_ref: string;
      benefit_minor: string;
      provider_idempotency_key: string;
    }>(
      `SELECT reservation_id, invoice_intent_ref, benefit_minor, provider_idempotency_key
       FROM s08_allocation_freeze_items WHERE freeze_id=$1 ORDER BY reservation_id`,
      [id],
    );
    if (
      items.rows.length !== candidate.allocations.length ||
      items.rows.some((row, i) => {
        const allocation = candidate.allocations[i];
        return (
          !allocation ||
          row.reservation_id !== allocation.reservationId ||
          row.invoice_intent_ref !== allocation.invoiceIntentRef ||
          BigInt(row.benefit_minor) !== BigInt(allocation.benefitMinor) ||
          row.provider_idempotency_key !== allocation.providerIdempotencyKey
        );
      })
    ) {
      throw new AllocationFreezeConflict('VERIFICATION_FAILED');
    }
    await client.query('COMMIT');
    return {
      id,
      artifact: candidate,
      replay: inserted.rowCount === 0,
      providerVerified: false,
      consumptionAuthorized: false,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
