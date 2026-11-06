import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { readAuthorization, type StoredAuthorization } from '../../partner-credits/partner-credit-settlement-authorization';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type StoredCustodyAuthorizationLink = Readonly<{
  authorizationId: string;
  evidenceId: string;
  businessId: string;
  reservationId: string;
  payloadSha256: string;
  custodyKeyId: string;
  custodyKeyVersion: number;
  authorizationEvidenceDigest: string;
}>;

export type RestrictedProvenanceRead =
  | Readonly<{ ok: true; authorization?: StoredAuthorization; link?: StoredCustodyAuthorizationLink }>
  | Readonly<{ ok: false; reason: 'INVALID_REQUEST' | 'UNAVAILABLE' }>;

/**
 * DEV-21 private/internal-only read. Uses the pre-existing authority-reader
 * role and its existing forced-RLS policy from migration 0066.
 * No D4 call site, public route, or role grants are added.
 *
 * A dedicated, independently provisioned read-only connection is required.
 * The ordinary application and recorder logins are NOT permitted to assume
 * settlement_authority_reader (see settlement-authority-provisioning.sql).
 * Never borrow a financial-consumer or recorder connection for this read.
 * The pre-existing authorization read function selects the newest snapshot.
 * This deliberately refuses to claim a historical authorization is current.
 */
export async function readRestrictedDurableProvenance(
  db: Database,
  input: Readonly<{ businessId: string; reservationId: string; authorizationId: string }>,
): Promise<RestrictedProvenanceRead> {
  if (!input || !UUID.test(input.businessId) ||
      !UUID.test(input.reservationId) || !UUID.test(input.authorizationId))
    return { ok: false, reason: 'INVALID_REQUEST' };

  try {
    return await db.transaction(async tx => {
      // No SET ROLE: the caller must already hold an explicitly authorized
      // read-only database principal. Unauthorized sessions fail closed.
      const authorization = await readAuthorization(tx, input.businessId, input.reservationId);
      if (!authorization || authorization.id !== input.authorizationId)
        return { ok: true, authorization: undefined, link: undefined };

      const result = await tx.execute(sql`
        select authorization_id, evidence_id, business_id, reservation_id,
               payload_sha256, custody_key_id, custody_key_version,
               authorization_evidence_digest
          from public.settlement_custody_authorization_links
         where business_id = ${input.businessId}::uuid
           and reservation_id = ${input.reservationId}::uuid
           and authorization_id = ${input.authorizationId}::uuid
         limit 1
      `);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) return { ok: true, authorization, link: undefined };
      const link: StoredCustodyAuthorizationLink = {
        authorizationId: String(row.authorization_id),
        evidenceId: String(row.evidence_id),
        businessId: String(row.business_id),
        reservationId: String(row.reservation_id),
        payloadSha256: String(row.payload_sha256),
        custodyKeyId: String(row.custody_key_id),
        custodyKeyVersion: Number(row.custody_key_version),
        authorizationEvidenceDigest: String(row.authorization_evidence_digest),
      };
      return { ok: true, authorization, link };
    });
  } catch {
    return { ok: false, reason: 'UNAVAILABLE' };
  }
}
