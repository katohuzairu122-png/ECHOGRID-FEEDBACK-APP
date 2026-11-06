import type { VerifiedCustodyReader } from './custody-settlement-classification';
import { isIssuedCustodyReader, type RetrieveResult } from './signed-evidence-custody';

/**
 * DEV-20.B: runtime-only, unforgeable capability minted after a REAL custody
 * read. Only the trusted reader service registers these immutable objects.
 * Never accept a caller-constructed lookalike as evidence of authenticity.
 */
const issued = new WeakSet<object>();
export interface TrustedCustodyReceipt {
  readonly evidenceId: string;
  readonly businessId: string;
  readonly reservationId: string;
  readonly payloadSha256: string;
  readonly custodyKeyId: string;
  readonly custodyKeyVersion: number;
}
export const isTrustedCustodyReceipt = (value: unknown): value is TrustedCustodyReceipt =>
  !!value && typeof value === 'object' && issued.has(value);

export type CustodyReceiptReadResult =
  | Readonly<{ ok: true; custody: Extract<RetrieveResult, { ok: true }>; receipt: TrustedCustodyReceipt }>
  | Readonly<{ ok: false; reason: 'CUSTODY_NOT_TRUSTED' | 'CUSTODY_UNAVAILABLE' | 'CUSTODY_UNVERIFIED' | 'BINDING_MISMATCH' }>;

export async function readTrustedCustodyForRecorder(
  reader: VerifiedCustodyReader,
  request: Readonly<{ evidenceId: string; businessId: string; reservationId: string }>,
): Promise<CustodyReceiptReadResult> {
  if (!isIssuedCustodyReader(reader)) return { ok: false, reason: 'CUSTODY_NOT_TRUSTED' };
  let result: RetrieveResult;
  try {
    result = (await reader.retrieve({
      evidenceId: request.evidenceId,
      businessId: request.businessId,
      purpose: 'SYNTHETIC_TEST_EVIDENCE', evidenceType: 'SYNTHETIC_TEST_EVIDENCE',
    })) as unknown as RetrieveResult;
  } catch { return { ok: false, reason: 'CUSTODY_UNAVAILABLE' }; }
  if (!result.ok) return { ok: false, reason: 'CUSTODY_UNAVAILABLE' };
  if (result.authenticity !== 'AUTHENTIC' || result.financialAuthorization !== 'NOT_GRANTED' ||
      result.keyState !== 'ACTIVE' || result.evidenceId !== request.evidenceId ||
      result.claims.businessId !== request.businessId || result.claims.environment !== 'development' ||
      result.claims.purpose !== 'SYNTHETIC_TEST_EVIDENCE' ||
      result.claims.evidenceType !== 'SYNTHETIC_TEST_EVIDENCE')
    return { ok: false, reason: 'CUSTODY_UNVERIFIED' };
  const payload = result.payload;
  if (!payload || Object.keys(payload).length !== 1 || !Object.prototype.hasOwnProperty.call(payload, 'settlementEvidence') ||
      !payload.settlementEvidence || typeof payload.settlementEvidence !== 'object' || Array.isArray(payload.settlementEvidence))
    return { ok: false, reason: 'BINDING_MISMATCH' };
  const evidence = payload.settlementEvidence as Record<string, unknown>;
  const binding = evidence.binding as Record<string, unknown> | undefined;
  const provenance = evidence.provenance as Record<string, unknown> | undefined;
  if (binding?.businessId !== request.businessId || binding?.reservationId !== request.reservationId ||
      provenance?.evidenceKind !== 'MOCK_SYNTHETIC')
    return { ok: false, reason: 'BINDING_MISMATCH' };
  const receipt = Object.freeze({
    evidenceId: request.evidenceId,
    businessId: request.businessId,
    reservationId: request.reservationId,
    payloadSha256: result.claims.payloadSha256,
    custodyKeyId: result.claims.keyId,
    custodyKeyVersion: result.claims.keyVersion,
  });
  issued.add(receipt);
  return { ok: true, custody: result, receipt };
}
