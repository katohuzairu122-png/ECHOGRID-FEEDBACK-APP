import { canonicalJson, sha256Hex } from './bundle-builder';
import type { RetrieveResult } from './signed-evidence-custody';
import type { StoredAuthorization } from '../../partner-credits/partner-credit-settlement-authorization';
import { settlementAuthorizationDigest, verifySettlementProvenance } from '../../partner-credits/partner-credit-settlement-authorization';

/**
 * DEV-20 preliminary, PURE reconciliation contract. Does not persist or grant
 * financial authority. A passing result is NOT a durable custody-to-recorder
 * linkage: migration and atomic recorder transaction remain mandatory.
 *
 * Inputs must come from the genuine DEV-15 custody reader and the database's
 * restricted settlement authorization read function. The contract does not
 * mint trusted identity from caller-supplied structs.
 */
export type ProposedCustodyAuthorizationLink = Readonly<{
  evidenceId: string;
  authorizationId: string;
  businessId: string;
  reservationId: string;
  payloadSha256: string;
  custodyKeyId: string;
  custodyKeyVersion: number;
  authorizationEvidenceDigest: string;
}>;

export type ProvenanceCheck =
  | Readonly<{ ok: true; link: ProposedCustodyAuthorizationLink; financialAuthorization: 'NOT_GRANTED'; durable: false }>
  | Readonly<{ ok: false; reason: 'INVALID_LINK' | 'CUSTODY_UNVERIFIED' | 'CUSTODY_MISMATCH' | 'AUTHORIZATION_MISMATCH' | 'AUTHORIZATION_UNVERIFIED'; financialAuthorization: 'NOT_GRANTED'; durable: false }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const fail = (reason: Extract<ProvenanceCheck, { ok: false }>['reason']): ProvenanceCheck =>
  ({ ok: false, reason, financialAuthorization: 'NOT_GRANTED', durable: false });

export async function checkProposedCustodyAuthorizationLink(
  link: ProposedCustodyAuthorizationLink,
  custody: RetrieveResult,
  auth: StoredAuthorization,
  recorderPublicKeys: Readonly<Record<string, string>>,
): Promise<ProvenanceCheck> {
  if (!link || !UUID.test(link.evidenceId) || !UUID.test(link.authorizationId) ||
    !UUID.test(link.businessId) || !UUID.test(link.reservationId) ||
    !HASH.test(link.payloadSha256) || !HASH.test(link.authorizationEvidenceDigest) ||
    typeof link.custodyKeyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(link.custodyKeyId) ||
    !Number.isSafeInteger(link.custodyKeyVersion) || link.custodyKeyVersion < 1)
    return fail('INVALID_LINK');

  if (!custody?.ok || custody.authenticity !== 'AUTHENTIC' ||
    custody.financialAuthorization !== 'NOT_GRANTED' || custody.keyState !== 'ACTIVE' ||
    custody.claims.environment !== 'development' || custody.claims.purpose !== 'SYNTHETIC_TEST_EVIDENCE' ||
    custody.claims.evidenceType !== 'SYNTHETIC_TEST_EVIDENCE') return fail('CUSTODY_UNVERIFIED');

  if (custody.evidenceId !== link.evidenceId || custody.claims.businessId !== link.businessId ||
    custody.claims.keyId !== link.custodyKeyId || custody.claims.keyVersion !== link.custodyKeyVersion ||
    custody.claims.payloadSha256 !== link.payloadSha256 ||
    !custody.payload || typeof custody.payload !== 'object' || Array.isArray(custody.payload) ||
    Object.keys(custody.payload).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(custody.payload, 'settlementEvidence'))
    return fail('CUSTODY_MISMATCH');

  if (await sha256Hex(canonicalJson(custody.payload)) !== link.payloadSha256)
    return fail('CUSTODY_MISMATCH');

  const e = custody.payload.settlementEvidence as Record<string, unknown> | null;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return fail('CUSTODY_MISMATCH');
  const binding = e.binding as Record<string, unknown> | null;
  const provider = e.provider as Record<string, unknown> | null;
  const invoice = e.invoice as Record<string, unknown> | null;
  const provenance = e.provenance as Record<string, unknown> | null;
  if (!binding || !provider || !invoice || !provenance ||
    binding.businessId !== link.businessId || binding.reservationId !== link.reservationId ||
    invoice.id !== auth?.invoiceRef || provider.accountId !== auth?.providerAccountId ||
    provider.mode !== auth?.providerMode || provenance.snapshotRef !== auth?.snapshotRef ||
    provenance.snapshotDigest !== auth?.snapshotDigest || provenance.observedAtMs !== auth?.observedAtMs)
    return fail('CUSTODY_MISMATCH');

  if (!auth || auth.id !== link.authorizationId || auth.businessId !== link.businessId ||
    auth.reservationId !== link.reservationId || auth.evidenceKind !== 'MOCK_SYNTHETIC' ||
    auth.evidenceDigest !== link.authorizationEvidenceDigest || auth.provenanceVersion !== 1)
    return fail('AUTHORIZATION_MISMATCH');

  const recomputed = await settlementAuthorizationDigest(auth);
  if (recomputed !== auth.evidenceDigest ||
    !(await verifySettlementProvenance(auth.signingKeyId, auth.evidenceDigest, auth.signature, recorderPublicKeys)))
    return fail('AUTHORIZATION_UNVERIFIED');

  return Object.freeze({ ok: true, link: Object.freeze({ ...link }), financialAuthorization: 'NOT_GRANTED', durable: false });
}
