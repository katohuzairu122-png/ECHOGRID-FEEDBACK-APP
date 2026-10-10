import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { PartnerEnrollmentService } from '../../src/partner-credits/partner-enrollment.service';

describe.skipIf(!process.env.DATABASE_URL)('Split 07 Block 2 enrollment authority (PostgreSQL)', () => {
  let client: Client;
  let service: PartnerEnrollmentService;
  let businessId: string;
  let userId: string;
  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    service = new PartnerEnrollmentService(buildDb(client));
    const suffix = crypto.randomUUID();
    const b = await client.query<{id:string}>('INSERT INTO businesses(name,slug) VALUES($1,$2) RETURNING id', ['Partner Enrollment Neg Test', 's07-enrollment-'+suffix]);
    businessId = b.rows[0]!.id;
    const u = await client.query<{id:string}>('INSERT INTO users(email,password_hash,full_name,status) VALUES($1,$2,$3,$4) RETURNING id', ['s07-enrollment-'+suffix+'@example.test','unused','Enrollee','active']);
    userId = u.rows[0]!.id;
  });
  afterAll(async () => { if (client) await client.end(); });

  it('denies enrollment with a non-admin platform actor', async () => {
    await expect(service.enroll({ businessId, consentingUserId:userId, platformAdminId:userId, policyVersion:'PC-ECON/1' }))
      .rejects.toThrow('PARTNER_ENROLLMENT_ADMIN_REQUIRED');
  });
  it('does not accept an unrelated business user even if a platform admin invokes it', async () => {
    const admin = await client.query<{id:string}>('INSERT INTO users(email,password_hash,full_name,status,platform_role) VALUES($1,$2,$3,$4,$5) RETURNING id',
      ['s07-platform-'+crypto.randomUUID()+'@example.test','unused','Platform Admin','active','admin']);
    await expect(service.enroll({businessId,consentingUserId:userId,platformAdminId:admin.rows[0]!.id,policyVersion:'PC-ECON/1'}))
      .rejects.toThrow('PARTNER_ENROLLMENT_BUSINESS_WIDE_CONSENT_REQUIRED');
    expect(await service.findForBusiness(businessId)).toBeUndefined();
  });
});
