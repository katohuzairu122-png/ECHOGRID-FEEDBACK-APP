/**
 * Gate 2 B4: nonfinancial branch-read adapter for a future restricted broker.
 *
 * NOT mounted in a route or granted permissions. The function does not exist
 * on the deployed database. Calling it without a separately certified issuer
 * and restricted PG login must fail closed; do not replace it with direct SQL.
 */
export type B4SignedBranchAssertion = Readonly<{
  kid: string;
  issuer: string;
  audience: string;
  actorId: string;
  sessionId: string;
  businessId: string;
  branchId: string;
  operation: 'branches:read';
  nonce: string;
  requestId: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}>;

export type B4PublicBranch = Readonly<{
  id: string;
  businessId: string;
  name: string;
  slug: string;
  status: 'active' | 'inactive' | 'archived';
}>;

type QueryRow = {
  branch_id: unknown;
  business_id: unknown;
  branch_name: unknown;
  branch_slug: unknown;
  branch_status: unknown;
};

export type B4RestrictedQuery = {
  query(text: string, values: readonly (string | number)[]): Promise<{ rows: QueryRow[] }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_SIGNATURE = /^[0-9a-f]{64}$/;
const maxTimestampSeconds = 120;

function nonempty(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[a-zA-Z0-9:_-]+$/.test(value);
}

/** Syntactic guard only. Signature verification is the DATABASE broker's job. */
function assertEnvelope(a: B4SignedBranchAssertion): void {
  if (!a || !nonempty(a.kid) || !nonempty(a.issuer) || !nonempty(a.audience) ||
      !UUID.test(a.actorId) || !UUID.test(a.sessionId) || !UUID.test(a.businessId) ||
      !UUID.test(a.branchId) || !UUID.test(a.nonce) || !UUID.test(a.requestId) ||
      a.operation !== 'branches:read' || !HEX_SIGNATURE.test(a.signature) ||
      !Number.isSafeInteger(a.issuedAt) || !Number.isSafeInteger(a.expiresAt) ||
      a.expiresAt <= a.issuedAt || a.expiresAt - a.issuedAt > maxTimestampSeconds) {
    throw new Error('B4_ASSERTION_REJECTED');
  }
}

// Intentionally SQL-function-only. The runtime restricted login must have
// EXECUTE on exactly this audited function and NO direct table SELECT rights.
// This is a future interface contract, not an installed migration.
export const B4_BRANCH_READ_SQL =
  'SELECT branch_id,business_id,branch_name,branch_slug,branch_status ' +
  'FROM gate2_b4.read_one_branch($1::text,$2::text,$3::text,$4::uuid,$5::uuid,' +
  '$6::uuid,$7::uuid,$8::text,$9::uuid,$10::uuid,$11::bigint,$12::bigint,$13::text)';

export async function readOneBranchViaBroker(
  restricted: B4RestrictedQuery,
  assertion: B4SignedBranchAssertion,
): Promise<B4PublicBranch | null> {
  assertEnvelope(assertion);
  const result = await restricted.query(B4_BRANCH_READ_SQL, [
    assertion.kid, assertion.issuer, assertion.audience, assertion.actorId,
    assertion.sessionId, assertion.businessId, assertion.branchId,
    assertion.operation, assertion.nonce, assertion.requestId,
    assertion.issuedAt, assertion.expiresAt, assertion.signature,
  ]);
  if (!Array.isArray(result.rows) || result.rows.length > 1) {
    throw new Error('B4_BROKER_RESPONSE_REJECTED');
  }
  const row = result.rows[0];
  if (!row) return null;
  if (row.business_id !== assertion.businessId || row.branch_id !== assertion.branchId ||
      typeof row.branch_name !== 'string' || row.branch_name.length > 256 ||
      typeof row.branch_slug !== 'string' || row.branch_slug.length > 256 ||
      !['active', 'inactive', 'archived'].includes(String(row.branch_status))) {
    throw new Error('B4_BROKER_RESPONSE_REJECTED');
  }
  return {
    id: row.branch_id,
    businessId: row.business_id,
    name: row.branch_name,
    slug: row.branch_slug,
    status: row.branch_status,
  } as B4PublicBranch;
}
