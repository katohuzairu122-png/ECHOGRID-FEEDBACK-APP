import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { PartnerProvisionalAwardService } from '../../src/partner-credits/partner-provisional-award.service';
import type { OrphanSettlementCompletionEvidence } from '@echo-grid-feedback/shared-types';

describe.skipIf(!process.env.DATABASE_URL)('Split 07 atomic award fail-closed gates (PostgreSQL)', () => {
  let client: Client;
  let service: PartnerProvisionalAwardService;
  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    service = new PartnerProvisionalAwardService(buildDb(client));
  });
  afterAll(async () => { if (client) await client.end(); });

  it('does not award an invented fulfillment reference', async () => {
    const evidence: OrphanSettlementCompletionEvidence = {
      evidenceVersion: 'v1',
      settlementRef: crypto.randomUUID(),
      claimId: crypto.randomUUID(),
      customerId: crypto.randomUUID(),
      originBusinessId: crypto.randomUUID(),
      receivingBusinessId: crypto.randomUUID(),
      receivingBranchId: null,
      fulfilledAt: new Date().toISOString(),
      fulfillmentPolicyVersion: 'v1',
      fulfillmentReference: null,
    };
    await expect(service.decide(evidence)).rejects.toThrow('PARTNER_AWARD_SETTLEMENT_EVIDENCE_INVALID');
    const result = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM partner_credit_award_decisions');
    expect(Number(result.rows[0]!.count)).toBe(0);
  });

  it('keeps database economic issuance barriers in place', async () => {
    const result = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_trigger WHERE tgname IN ('partner_credit_awards_insert_disabled','partner_credit_ledger_insert_disabled','partner_credit_lots_inert_guard','partner_credit_accounts_inert_guard') AND tgenabled='O'",
    );
    expect(Number(result.rows[0]!.count)).toBe(4);
  });
});
