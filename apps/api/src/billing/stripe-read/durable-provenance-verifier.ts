import type { Database } from '../../db/client';
import type { VerifiedCustodyReader } from './custody-settlement-classification';
import { isIssuedCustodyReader, type RetrieveResult } from './signed-evidence-custody';
import { checkProposedCustodyAuthorizationLink } from './custody-authorization-provenance';
import { durableProvenanceResult, type DurableProvenanceResult } from './durable-provenance-result';
import { readRestrictedDurableProvenance } from './restricted-durable-provenance-read';

/**
 * DEV-21 internal-only verifier, not a financial decision or a public route.
 * The trusted composition root must supply the genuine custody service reader,
 * which checks workload entitlement and current key state on every retrieval.
 */
export async function verifyDurableSettlementProvenance(
  db: Database,
  custodyReader: VerifiedCustodyReader,
  input: Readonly<{ businessId: string; reservationId: string; authorizationId: string }>,
  recorderPublicKeys: Readonly<Record<string, string>>,
): Promise<DurableProvenanceResult> {
  if (!isIssuedCustodyReader(custodyReader)) return durableProvenanceResult('UNAVAILABLE');

  const read = await readRestrictedDurableProvenance(db, input);
  if (!read.ok) return durableProvenanceResult('UNAVAILABLE');
  if (!read.authorization || !read.link) return durableProvenanceResult('UNLINKED');

  const { authorization, link } = read;
  if (authorization.id !== link.authorizationId ||
      authorization.businessId !== link.businessId ||
      authorization.reservationId !== link.reservationId ||
      authorization.evidenceDigest !== link.authorizationEvidenceDigest)
    return durableProvenanceResult('INVALID');

  let custody: RetrieveResult;
  try {
    custody = await custodyReader.retrieve({
      evidenceId: link.evidenceId,
      businessId: link.businessId,
      purpose: 'SYNTHETIC_TEST_EVIDENCE',
      evidenceType: 'SYNTHETIC_TEST_EVIDENCE',
    }) as RetrieveResult;
  } catch {
    return durableProvenanceResult('UNAVAILABLE');
  }
  if (!custody.ok) return durableProvenanceResult('UNAVAILABLE');

  try {
    const result = await checkProposedCustodyAuthorizationLink({
      evidenceId: link.evidenceId,
      authorizationId: link.authorizationId,
      businessId: link.businessId,
      reservationId: link.reservationId,
      payloadSha256: link.payloadSha256,
      custodyKeyId: link.custodyKeyId,
      custodyKeyVersion: link.custodyKeyVersion,
      authorizationEvidenceDigest: link.authorizationEvidenceDigest,
    }, custody, authorization, recorderPublicKeys);
    return durableProvenanceResult(result.ok ? 'VERIFIED' : 'INVALID');
  } catch {
    return durableProvenanceResult('UNAVAILABLE');
  }
}
