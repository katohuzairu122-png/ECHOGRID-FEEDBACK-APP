import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { PartnerEnrollmentService } from '../../src/partner-credits/partner-enrollment.service';
import { PartnerProvisionalAwardPlanner } from '../../src/partner-credits/partner-provisional-award.planner';

describe.skipIf(!process.env.DATABASE_URL)('Split 07 authenticated Partner enrollment lifecycle (PostgreSQL)', () => {
  let client: Client;
  let service: PartnerEnrollmentService;
  let planner: PartnerProvisionalAwardPlanner;
  let businessId: string, actorId: string, adminId: string;
  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const uid = crypto.randomUUID();
    businessId = (await client.query<{ id: string }>('INSERT INTO businesses(name,slug) VALUES($1,$2) RETURNING id', ['Partner Enrollment Lifecycle', 'partner-lifecycle-'+uid])).rows[0]!.id;
    actorId = (await client.query<{ id: string }>('INSERT INTO users(email,password_hash,full_name,status) VALUES($1,$2,$3,$4) RETURNING id',
      ['partner-consent-'+uid+'@example.test','unused','Partner Consenter','active'])).rows[0]!.id;
    adminId = (await client.query<{ id: string }>('INSERT INTO users(email,password_hash,full_name,status,platform_role) VALUES($1,$2,$3,$4,$5) RETURNING id',
      ['partner-admin-'+uid+'@example.test','unused','Partner Admin','active','admin'])).rows[0]!.id;
    const roleId = (await client.query<{ id: string }>('INSERT INTO roles(business_id,name) VALUES($1,$2) RETURNING id', [businessId,'Partner Lifecycle Owner'])).rows[0]!.id;
    await client.query('INSERT INTO user_business_roles(user_id,business_id,role_id) VALUES($1,$2,$3)', [actorId,businessId,roleId]);
    await client.query("INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE key='billing:manage'", [roleId]);
    service = new PartnerEnrollmentService(buildDb(client));
    planner = new PartnerProvisionalAwardPlanner(buildDb(client));
  });
  afterAll(async () => { if (client) await client.end(); });

  it('rejects enrollment without a receipt and planning with no qualifying settlement', async () => {
    await expect(service.enroll({businessId,consentingUserId:actorId,platformAdminId:adminId,
      policyVersion:'PC-ECON/1',acceptanceRef:crypto.randomUUID()})).rejects.toThrow();
    expect((await planner.inspect({businessId,settlementRef:crypto.randomUUID()})).state).toBe('ineligible');
  });

  it('allows accepted terms and a separate admin approval against an active frozen policy', async () => {
    const policy = await client.query<{ id: string }>(
      "INSERT INTO partner_credit_policies(version,state,effective_at) VALUES($1,'active',$2) RETURNING id",
      ['PC-ECON/1',new Date(Date.now()-86400_000)]);
    expect(policy.rows.length).toBe(1);
    const receipt = await service.recordAcceptance({businessId,authenticatedUserId:actorId,
      policyVersion:'PC-ECON/1',termsDigest:'a'.repeat(64)});
    const enrollment = await service.enroll({businessId,consentingUserId:actorId,
      platformAdminId:adminId,policyVersion:'PC-ECON/1',acceptanceRef:receipt.acceptanceRef});
    expect(enrollment.status).toBe('active');
    expect(enrollment.acceptedByUserId).toBe(actorId);
    const audit = await client.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE business_id=$1 AND action LIKE 'partner_credit_program.%'",[businessId]);
    expect(audit.rows.map(r=>r.action)).toContain('partner_credit_program.terms_accepted');
    expect(audit.rows.map(r=>r.action)).toContain('partner_credit_program.enrollment_approved');
    await expect(service.enroll({businessId,consentingUserId:actorId,
      platformAdminId:adminId,policyVersion:'PC-ECON/1',acceptanceRef:receipt.acceptanceRef}))
      .rejects.toThrow('PARTNER_ENROLLMENT_ALREADY_EXISTS');
  });
});
