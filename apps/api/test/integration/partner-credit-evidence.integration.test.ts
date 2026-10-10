import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { PartnerCreditEvidenceVerifier } from '../../src/partner-credits/partner-credit-evidence.verifier';
import type { OrphanSettlementCompletionEvidence } from '@echo-grid-feedback/shared-types';

describe.skipIf(!process.env.DATABASE_URL)('Split 07 Block 2 settlement evidence fail-closed verification', () => {
  let client: Client;
  let verifier: PartnerCreditEvidenceVerifier;
  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    verifier = new PartnerCreditEvidenceVerifier(buildDb(client));
  });
  afterAll(async () => { if (client) await client.end(); });
  it('rejects unresolvable completion evidence without creating credits', async () => {
    const id = crypto.randomUUID();
    const evidence: OrphanSettlementCompletionEvidence = {
      evidenceVersion:'v1',settlementRef:id,claimId:crypto.randomUUID(),
      customerId:crypto.randomUUID(),originBusinessId:crypto.randomUUID(),
      receivingBusinessId:crypto.randomUUID(),receivingBranchId:null,
      fulfilledAt:new Date().toISOString(),fulfillmentPolicyVersion:'v1',fulfillmentReference:null,
    };
    expect(await verifier.verify(evidence)).toBeNull();
    const row = await client.query<{ total: string }>('SELECT count(*)::text AS total FROM partner_credit_award_decisions');
    expect(Number(row.rows[0]!.total)).toBe(0);
  });
});
