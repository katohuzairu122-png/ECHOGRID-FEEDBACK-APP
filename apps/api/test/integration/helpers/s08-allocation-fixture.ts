import type { Client } from 'pg';
import type { IntentView } from '../../../src/billing/benefit-application.saga.service';
import { freezeAggregateBenefitAllocation } from '../../../src/billing/aggregate-benefit-allocation';
import { computeInvoiceBenefit } from '../../../src/billing/invoice-benefit.calculator';

/** Synthetic evidence for existing saga tests, never an authorized append path.
 * Requires their unique scratch DB and already privileged fixture connection. */
export async function seedScratchAllocation(client: Client, intent: IntentView) {
  const context = (
    await client.query<{ db: string; replication: string }>(
      "SELECT current_database() db, current_setting('session_replication_role') replication",
    )
  ).rows[0]!;
  if (!/^echogrid_s08_/.test(context.db) || context.replication !== 'replica')
    throw new Error('Synthetic allocation requires a scratch-only fixture connection');
  const reservation = (
    await client.query<{ invoice_intent_ref: string }>(
      'SELECT invoice_intent_ref FROM partner_credit_reservations WHERE id=$1',
      [intent.reservationId],
    )
  ).rows[0]!;
  const base = intent.expectedBenefitMinor * 100;
  const benefit = computeInvoiceBenefit(
    {
      invoiceId: intent.invoiceRef,
      invoiceBusinessId: intent.businessId,
      currency: intent.currency,
      status: 'paid',
      amountDueMinor: base,
      amountPaidMinor: base,
      interval: 'month',
      trialOrFree: false,
      lines: [
        {
          id: 'synthetic_base',
          category: 'recurring_base',
          amountMinor: base,
          currency: intent.currency,
        },
      ],
    },
    { creditBusinessId: intent.businessId, requestedUnits: 1, availableUnits: 1 },
  );
  if (!benefit.eligible) throw new Error('Synthetic allocation calculator denied fixture');
  const artifact = await freezeAggregateBenefitAllocation({
    allocationPolicyVersion: 'S08-AGG-ROUND/1',
    invoice: {
      businessId: intent.businessId,
      invoiceRef: intent.invoiceRef,
      currency: intent.currency,
    },
    benefit,
    eligibleCreditBalance: 1,
    reservations: [
      {
        id: intent.reservationId,
        businessId: intent.businessId,
        invoiceIntentRef: reservation.invoice_intent_ref,
        invoiceRef: intent.invoiceRef,
        currency: intent.currency,
        units: 1,
        state: 'reserved',
        providerAttemptStarted: false,
      },
    ],
  });
  await client.query('BEGIN');
  try {
    const parent = (
      await client.query<{ id: string }>(
        `INSERT INTO s08_allocation_freezes
      (business_id,invoice_ref,currency,policy_version,allocation_digest,aggregate_benefit_minor,reservation_count,artifact)
      VALUES ($1,$2,$3,$4,$5,$6,1,$7::jsonb) RETURNING id`,
        [
          intent.businessId,
          intent.invoiceRef,
          intent.currency,
          artifact.allocationPolicyVersion,
          artifact.allocationDigest,
          artifact.aggregateBenefitMinor,
          JSON.stringify(artifact),
        ],
      )
    ).rows[0]!;
    const item = artifact.allocations[0]!;
    await client.query(
      `INSERT INTO s08_allocation_freeze_items
      (freeze_id,business_id,reservation_id,invoice_intent_ref,benefit_minor,provider_idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        parent.id,
        intent.businessId,
        intent.reservationId,
        item.invoiceIntentRef,
        item.benefitMinor,
        item.providerIdempotencyKey,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
