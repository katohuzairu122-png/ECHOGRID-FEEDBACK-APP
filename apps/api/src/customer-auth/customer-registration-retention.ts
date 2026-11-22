import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';

/**
 * CUSTOMER-AUTH-UX-02-R2: deliberately UNWIRED, bounded cleanup primitive.
 *
 * Removes only sealed pending-registration setup data after the challenge's
 * existing 15-minute validity window has ended. It does not delete challenge
 * rows, proofs, attempt counters, or audit/consent evidence.
 *
 * No cron, route, queue, or scheduled caller is authorized by this module.
 * Owner privacy approval, execution cadence and observability are separate
 * activation gates. A caller must supply a trusted server timestamp.
 */
export async function purgeExpiredRegistrationCiphertext(
  db: Database,
  now: Date,
  batchSize: number,
): Promise<void> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('A valid trusted timestamp is required');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error('Cleanup batch size must be between 1 and 500');
  }

  // Concurrent workers may process distinct batches; no registration that can
  // still consume a proof is eligible. Preserve the historical challenge row.
  await db.execute(sql`
    WITH expired AS (
      SELECT id
      FROM customer_auth_challenges
      WHERE purpose = 'email_registration'
        AND registration_sealed_data IS NOT NULL
        AND expires_at <= ${now}
      ORDER BY expires_at, id
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE customer_auth_challenges AS challenge
       SET registration_sealed_data = NULL
      FROM expired
     WHERE challenge.id = expired.id
  `);
}
