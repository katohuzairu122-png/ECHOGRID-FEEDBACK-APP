import type { Database } from '../../db/client';
import type { VerifiedCustodyReader } from './custody-settlement-classification';
import type { WorkloadConfigSource, WorkloadEnvironment } from './workload-identity';
import { SIGNING_BUSINESS_ID } from './evidence-signing-workload';
import { isIssuedCustodyReader } from './signed-evidence-custody';
import { verifyDurableSettlementProvenance } from './durable-provenance-verifier';
import { durableProvenanceResult, type DurableProvenanceResult } from './durable-provenance-result';

/**
 * DEV-22: private, development-only authorization boundary for DEV-21 reads.
 *
 * This component intentionally does not expose a route, database credential,
 * signing credential, financial action, consumer, or recovery writer.
 * Its workload source must be supplied by a trusted service composition root.
 * Unprovisioned sources always deny.
 */
type AuditWorkloadRecord = Readonly<{
  workloadId: string;
  role: 'PROVENANCE_AUDITOR';
  environment: 'development';
  businessIds: readonly string[];
  validFromMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$/;
const own = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);
const validTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function parseAuditRecord(value: unknown): AuditWorkloadRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const fields = ['workloadId', 'role', 'environment', 'businessIds', 'validFromMs', 'expiresAtMs', 'revokedAtMs'];
  if (Object.keys(record).length !== fields.length || fields.some(f => !own(record, f))) return undefined;
  if (typeof record.workloadId !== 'string' || !ID.test(record.workloadId) ||
      record.role !== 'PROVENANCE_AUDITOR' || record.environment !== 'development' ||
      !Array.isArray(record.businessIds) || record.businessIds.length === 0 ||
      record.businessIds.length > 64 ||
      record.businessIds.some(b => typeof b !== 'string' || !SIGNING_BUSINESS_ID.test(b)) ||
      new Set(record.businessIds).size !== record.businessIds.length ||
      !validTime(record.validFromMs) || !validTime(record.expiresAtMs) ||
      record.expiresAtMs <= record.validFromMs ||
      (record.revokedAtMs !== null && !validTime(record.revokedAtMs)))
    return undefined;
  return record as AuditWorkloadRecord;
}

export interface ProvenanceAuditStage {
  verify(request: Readonly<{
    businessId: string;
    reservationId: string;
    authorizationId: string;
  }>): Promise<DurableProvenanceResult>;
}

/** Disabled-by-default configuration; not a new authorization grant. */
export function createUnprovisionedProvenanceAuditSource(): WorkloadConfigSource {
  return Object.freeze({ load: async () => null });
}

/**
 * No caller identity or 'verified' flag is accepted. The source is reloaded
 * before the read AND after verification so revocation or a tenant-scope
 * change during asynchronous work cannot produce a VERIFIED result.
 * The database connection must independently have the auditor read role.
 */
export function createPrivateProvenanceAuditStage(deps: Readonly<{
  db: Database;
  custodyReader: VerifiedCustodyReader;
  source: WorkloadConfigSource | null | undefined;
  environment: WorkloadEnvironment;
  clock: () => number;
  recorderPublicKeys: Readonly<Record<string, string>>;
}>): ProvenanceAuditStage {
  const permittedIdentity = async (businessId: string): Promise<string | null> => {
    if (!deps || deps.environment !== 'development' || !deps.source ||
        typeof deps.source.load !== 'function' || typeof deps.clock !== 'function')
      return null;
    try {
      const record = parseAuditRecord(await deps.source.load());
      const now = deps.clock();
      return record && validTime(now) && record.revokedAtMs === null &&
        now >= record.validFromMs && now < record.expiresAtMs &&
        record.businessIds.includes(businessId) ? record.workloadId : null;
    } catch { return null; }
  };

  return Object.freeze({
    async verify(request: Readonly<{ businessId: string; reservationId: string; authorizationId: string }>): Promise<DurableProvenanceResult> {
      if (!request || !UUID.test(request.businessId) ||
          !UUID.test(request.reservationId) || !UUID.test(request.authorizationId) ||
          !isIssuedCustodyReader(deps?.custodyReader))
        return durableProvenanceResult('UNAVAILABLE');
      const identityAtStart = await permittedIdentity(request.businessId);
      if (identityAtStart === null) return durableProvenanceResult('UNAVAILABLE');
      let result: DurableProvenanceResult;
      try {
        result = await verifyDurableSettlementProvenance(
          deps.db, deps.custodyReader, request, deps.recorderPublicKeys,
        );
      } catch { return durableProvenanceResult('UNAVAILABLE'); }
      // Require continuity of the same authority identity, not just any
      // newly-authorized actor for the same business, across asynchronous work.
      if ((await permittedIdentity(request.businessId)) !== identityAtStart)
        return durableProvenanceResult('UNAVAILABLE');
      return result;
    },
  });
}
