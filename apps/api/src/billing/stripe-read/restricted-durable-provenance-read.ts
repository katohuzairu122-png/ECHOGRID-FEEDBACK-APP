import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import type { StoredAuthorization } from '../../partner-credits/partner-credit-settlement-authorization';

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
  | Readonly<{ ok: true; authorization: StoredAuthorization | undefined; link: StoredCustodyAuthorizationLink | undefined }>
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
 * Apply the same newest-snapshot ordering as the pre-existing authority read
 * function. Auditors have SELECT under forced RLS, but have no EXECUTE grant
 * on the consumer/recorder-only authorization read function. No role switch
 * or permission grant is performed here.
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
      // Explicitly require the independent audit principal. A generic app
      // login or recorder cannot use this operation, even if it holds other
      // settlement permissions. No SET ROLE or additional GRANT is made.
      const access = await tx.execute(sql`
        select pg_has_role(current_user, 'settlement_auditor', 'USAGE') as permitted
      `);
      if ((access.rows[0] as { permitted?: boolean } | undefined)?.permitted !== true)
        throw new Error('DEDICATED_AUDITOR_ROLE_REQUIRED');

      const authRows = await tx.execute(sql`
        select * from public.partner_credit_settlement_authorizations
         where business_id = ${input.businessId}::uuid
           and reservation_id = ${input.reservationId}::uuid
         order by observed_at_ms desc, recorded_at desc, id desc
         limit 1
      `);
      const a = authRows.rows[0] as Record<string, unknown> | undefined;
      if (!a || a.id !== input.authorizationId)
        return { ok: true, authorization: undefined, link: undefined };
      const authorization: StoredAuthorization = {
        id: String(a.id), businessId: String(a.business_id),
        reservationId: String(a.reservation_id), decisionId: String(a.decision_id),
        invoiceRef: String(a.invoice_ref), providerAccountId: String(a.provider_account_id),
        providerMode: a.provider_mode as StoredAuthorization['providerMode'],
        allocationDigest: String(a.allocation_digest), policyVersion: String(a.policy_version),
        verdict: a.verdict as StoredAuthorization['verdict'],
        reasonCodes: a.reason_codes as string[],
        classifierVersion: String(a.classifier_version), evidenceKind: String(a.evidence_kind),
        billingInterval: a.billing_interval as StoredAuthorization['billingInterval'],
        snapshotRef: String(a.snapshot_ref), snapshotDigest: String(a.snapshot_digest),
        observedAtMs: Number(a.observed_at_ms), evidenceDigest: String(a.evidence_digest),
        provenanceVersion: Number(a.provenance_version),
        signingKeyId: String(a.signing_key_id), signature: String(a.signature),
      };

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
