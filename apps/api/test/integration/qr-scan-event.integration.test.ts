import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';

describe.skipIf(!process.env.DATABASE_URL)('QR scan-event deduplication (integration)', () => {
  let firstClient: Client;
  let secondClient: Client;
  let firstRepos: ReturnType<typeof createRepositories>;
  let secondRepos: ReturnType<typeof createRepositories>;
  let businessId: string;
  let branchId: string;
  let qrCodeId: string;

  beforeAll(async () => {
    firstClient = new Client({ connectionString: process.env.DATABASE_URL });
    secondClient = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    firstRepos = createRepositories(buildDb(firstClient));
    secondRepos = createRepositories(buildDb(secondClient));
    const business = await firstRepos.businesses.create({
      name: 'QR Scan Event Test',
      slug: `qr-scan-${crypto.randomUUID()}`,
    });
    businessId = business.id;
    const branch = await firstRepos.branches.create({
      businessId,
      name: 'Main',
      slug: `qr-scan-branch-${crypto.randomUUID()}`,
    });
    branchId = branch.id;
    qrCodeId = (await firstRepos.qrCodes.create({ businessId, branchId })).id;
  });

  afterAll(async () => {
    await firstRepos.businesses.softDelete(businessId, businessId);
    await Promise.all([firstClient.end(), secondClient.end()]);
  });

  it('atomically records one event when identical scans race', async () => {
    const input = {
      businessId,
      branchId,
      qrCodeId,
      clientHash: `hash-${crypto.randomUUID()}`,
      dedupBucket: new Date('2026-09-28T03:40:00Z'),
    };
    const [first, second] = await Promise.all([
      firstRepos.qrScanEvents.recordDeduplicated(input),
      secondRepos.qrScanEvents.recordDeduplicated(input),
    ]);
    expect([first.recorded, second.recorded].sort()).toEqual([false, true]);
    const count = await firstClient.query(
      'SELECT count(*)::int AS n FROM qr_scan_events WHERE qr_code_id = $1 AND client_hash = $2 AND dedup_bucket = $3',
      [qrCodeId, input.clientHash, input.dedupBucket],
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('keeps deduplication scoped to the QR code', async () => {
    const otherQr = await firstRepos.qrCodes.create({ businessId, branchId, type: 'scan-test-secondary' });
    const common = {
      businessId,
      branchId,
      clientHash: `hash-${crypto.randomUUID()}`,
      dedupBucket: new Date('2026-09-28T03:50:00Z'),
    };
    const first = await firstRepos.qrScanEvents.recordDeduplicated({ ...common, qrCodeId });
    const second = await firstRepos.qrScanEvents.recordDeduplicated({ ...common, qrCodeId: otherQr.id });
    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(true);
  });
});

