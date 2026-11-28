import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { RoleProvisioningService } from '../../src/rbac/role-provisioning.service';
import { B2bParticipationService } from '../../src/b2b/b2b-participation.service';
import { appDbOf } from '../helpers/runtime-db';

const DIGEST = 'a'.repeat(64);

/** SPLIT 09 S9-A1 (S9-D1) against REAL Postgres: fail-closed terms, enrollment authority, tenant isolation, guards. */
describe.skipIf(!process.env.DATABASE_URL)('B2B participation foundation (integration)', () => {
  let client: Client;
  let svc: B2bParticipationService;
  let repos: ReturnType<typeof createRepositories>;
  const ids = {} as {
    admin: string;
    support: string;
    bizA: string;
    bizB: string;
    ownerA: string;
    ownerB: string;
    managerA: string;
  };
  const version = `b2b-test-${crypto.randomUUID()}`;

  const user = async (label: string, platformRole?: string) =>
    (
      await client.query<{ id: string }>(
        'INSERT INTO users(email,password_hash,full_name,status,platform_role) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [
          `b2b-${label}-${crypto.randomUUID()}@example.test`,
          'x',
          label,
          'active',
          platformRole ?? null,
        ],
      )
    ).rows[0]!.id;
  const business = async (label: string) =>
    (
      await repos.businesses.create({
        name: `B2B ${label}`,
        slug: `b2b-${label}-${crypto.randomUUID()}`,
      })
    ).id;
  const sqlFails = async (text: string, params: unknown[], match: RegExp) => {
    await expect(client.query(text, params)).rejects.toThrow(match);
  };

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const db = buildDb(client);
    repos = createRepositories(db);
    svc = new B2bParticipationService(appDbOf(db));
    ids.admin = await user('admin', 'admin');
    ids.support = await user('support', 'support');
    ids.bizA = await business('a');
    ids.bizB = await business('b');
    ids.ownerA = await user('owner-a');
    ids.ownerB = await user('owner-b');
    ids.managerA = await user('manager-a');
    const rolesA = await new RoleProvisioningService(repos).seedDefaultRoles(ids.bizA, ids.ownerA);
    await repos.userBusinessRoles.grant({
      userId: ids.ownerA,
      businessId: ids.bizA,
      branchId: null,
      roleId: rolesA.Owner,
      createdBy: ids.ownerA,
    });
    await repos.userBusinessRoles.grant({
      userId: ids.managerA,
      businessId: ids.bizA,
      branchId: null,
      roleId: rolesA.Manager,
      createdBy: ids.ownerA,
    });
    const rolesB = await new RoleProvisioningService(repos).seedDefaultRoles(ids.bizB, ids.ownerB);
    await repos.userBusinessRoles.grant({
      userId: ids.ownerB,
      businessId: ids.bizB,
      branchId: null,
      roleId: rolesB.Owner,
      createdBy: ids.ownerB,
    });
    // Retire any leftover active terms from a previous local run (CI starts empty).
    await client.query(
      `UPDATE b2b_terms_versions SET state='retired', retired_at=now() WHERE state='active'`,
    );
  });
  afterAll(async () => {
    await client?.end();
  });

  it('fails closed: no active terms means no acceptance and no enrollment', async () => {
    await expect(
      svc.recordAcceptance({
        businessId: ids.bizA,
        authenticatedUserId: ids.ownerA,
        termsVersion: version,
      }),
    ).rejects.toMatchObject({ code: 'B2B_TERMS_NOT_ACTIVE' });
    await expect(
      svc.enroll({
        businessId: ids.bizA,
        consentingUserId: ids.ownerA,
        platformAdminId: ids.admin,
        termsVersion: version,
        acceptanceRef: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'B2B_TERMS_NOT_ACTIVE' });
    expect(await svc.isParticipating(ids.bizA)).toBe(false);
  });

  it('activates terms through the guarded draft -> active -> retired path only', async () => {
    await client.query(
      'INSERT INTO b2b_terms_versions(version,terms_digest,state) VALUES($1,$2,$3)',
      [version, DIGEST, 'draft'],
    );
    await sqlFails(
      `UPDATE b2b_terms_versions SET state='retired' WHERE version=$1`,
      [version],
      /B2B_TERMS_STATE_TRANSITION_DENIED/,
    );
    await sqlFails(
      `UPDATE b2b_terms_versions SET terms_digest=$2 WHERE version=$1`,
      [version, 'b'.repeat(64)],
      /B2B_TERMS_IMMUTABLE/,
    );
    await client.query(
      `UPDATE b2b_terms_versions SET state='active', effective_at=now()-interval '1 minute' WHERE version=$1`,
      [version],
    );
    await sqlFails(
      'DELETE FROM b2b_terms_versions WHERE version=$1',
      [version],
      /B2B_TERMS_DELETE_DENIED/,
    );
    await sqlFails(
      'TRUNCATE b2b_terms_versions',
      [],
      /B2B_TRUNCATE_DENIED|cannot truncate a table referenced/,
    );
  });

  it('acceptance needs business-wide authority of THAT business (manager, outsider, support all denied)', async () => {
    for (const [biz, userId] of [
      [ids.bizA, ids.managerA],
      [ids.bizA, ids.ownerB],
      [ids.bizB, ids.ownerA],
      [ids.bizA, ids.support],
    ] as const) {
      await expect(
        svc.recordAcceptance({
          businessId: biz,
          authenticatedUserId: userId,
          termsVersion: version,
        }),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  it('enrollment requires an active platform admin', async () => {
    const { acceptanceRef } = await svc.recordAcceptance({
      businessId: ids.bizA,
      authenticatedUserId: ids.ownerA,
      termsVersion: version,
    });
    for (const actor of [ids.support, ids.ownerA]) {
      await expect(
        svc.enroll({
          businessId: ids.bizA,
          consentingUserId: ids.ownerA,
          platformAdminId: actor,
          termsVersion: version,
          acceptanceRef,
        }),
      ).rejects.toMatchObject({ code: 'B2B_PLATFORM_ADMIN_REQUIRED' });
    }
    expect(await svc.findForBusiness(ids.bizA)).toBeUndefined();
  });

  it("another business's receipt cannot enroll this business", async () => {
    const { acceptanceRef } = await svc.recordAcceptance({
      businessId: ids.bizB,
      authenticatedUserId: ids.ownerB,
      termsVersion: version,
    });
    await expect(
      svc.enroll({
        businessId: ids.bizA,
        consentingUserId: ids.ownerB,
        platformAdminId: ids.admin,
        termsVersion: version,
        acceptanceRef,
      }),
    ).rejects.toMatchObject({ code: 'B2B_ENROLLMENT_VALID_ACCEPTANCE_REQUIRED' });
    await expect(
      svc.enroll({
        businessId: ids.bizA,
        consentingUserId: ids.ownerA,
        platformAdminId: ids.admin,
        termsVersion: version,
        acceptanceRef,
      }),
    ).rejects.toMatchObject({ code: 'B2B_ENROLLMENT_VALID_ACCEPTANCE_REQUIRED' });
    expect(await svc.findForBusiness(ids.bizA)).toBeUndefined();
  });

  it('a stale (>24h) receipt is refused', async () => {
    const { acceptanceRef } = await svc.recordAcceptance({
      businessId: ids.bizA,
      authenticatedUserId: ids.ownerA,
      termsVersion: version,
    });
    // Fixture only: audit_log is immutable (migration 0085), so the test connection (the table owner) lifts the guard inside one transaction
    // to backdate this receipt, then restores it. No production code path does this.
    await client.query('BEGIN');
    await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutability_guard_trg');
    await client.query(
      `UPDATE audit_log SET created_at = now() - interval '25 hours' WHERE id=$1`,
      [acceptanceRef],
    );
    await client.query(
      'ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_immutability_guard_trg',
    );
    await client.query('COMMIT');
    await expect(
      svc.enroll({
        businessId: ids.bizA,
        consentingUserId: ids.ownerA,
        platformAdminId: ids.admin,
        termsVersion: version,
        acceptanceRef,
      }),
    ).rejects.toMatchObject({ code: 'B2B_ENROLLMENT_VALID_ACCEPTANCE_REQUIRED' });
  });

  it('enrolls once, audits it, and is not repeatable', async () => {
    const { acceptanceRef } = await svc.recordAcceptance({
      businessId: ids.bizA,
      authenticatedUserId: ids.ownerA,
      termsVersion: version,
    });
    const row = await svc.enroll({
      businessId: ids.bizA,
      consentingUserId: ids.ownerA,
      platformAdminId: ids.admin,
      termsVersion: version,
      acceptanceRef,
    });
    expect(row).toMatchObject({
      businessId: ids.bizA,
      status: 'active',
      termsDigest: DIGEST,
      enrolledByUserId: ids.admin,
    });
    expect(await svc.isParticipating(ids.bizA)).toBe(true);
    expect(await svc.isParticipating(ids.bizB)).toBe(false);
    await expect(
      svc.enroll({
        businessId: ids.bizA,
        consentingUserId: ids.ownerA,
        platformAdminId: ids.admin,
        termsVersion: version,
        acceptanceRef,
      }),
    ).rejects.toMatchObject({ code: 'B2B_PARTICIPATION_ALREADY_EXISTS' });
    const audit = await client.query(
      `SELECT 1 FROM audit_log WHERE entity_id=$1 AND action='b2b.participation_enrolled'`,
      [row.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('suspend / reinstate are deterministic, admin-only, audited, and replay-safe', async () => {
    await expect(
      svc.suspend({ businessId: ids.bizA, platformAdminId: ids.support, reason: 'x' }),
    ).rejects.toMatchObject({ code: 'B2B_PLATFORM_ADMIN_REQUIRED' });
    await expect(
      svc.suspend({ businessId: ids.bizA, platformAdminId: ids.admin, reason: '  ' }),
    ).rejects.toMatchObject({ code: 'B2B_REASON_INVALID' });
    await expect(
      svc.reinstate({
        businessId: ids.bizA,
        platformAdminId: ids.admin,
        reason: 'review complete',
      }),
    ).rejects.toMatchObject({ code: 'B2B_PARTICIPATION_STATE_CONFLICT' });
    const suspended = await svc.suspend({
      businessId: ids.bizA,
      platformAdminId: ids.admin,
      reason: 'policy review',
    });
    expect(suspended.status).toBe('suspended');
    expect(await svc.isParticipating(ids.bizA)).toBe(false);
    await expect(
      svc.suspend({ businessId: ids.bizA, platformAdminId: ids.admin, reason: 'again' }),
    ).rejects.toMatchObject({ code: 'B2B_PARTICIPATION_STATE_CONFLICT' });
    await expect(
      svc.suspend({ businessId: ids.bizB, platformAdminId: ids.admin, reason: 'none' }),
    ).rejects.toMatchObject({ code: 'B2B_PARTICIPATION_NOT_FOUND' });
    expect(
      (
        await svc.reinstate({
          businessId: ids.bizA,
          platformAdminId: ids.admin,
          reason: 'review complete',
        })
      ).status,
    ).toBe('active');
    const n = await client.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE business_id=$1 AND action IN ('b2b.participation_suspended','b2b.participation_reinstated')`,
      [ids.bizA],
    );
    expect(n.rows[0].n).toBe(2);
    const moderation = await client.query(
      `SELECT count(*)::int AS n FROM b2b_moderation_actions WHERE target_business_id=$1`,
      [ids.bizA],
    );
    expect(moderation.rows[0].n).toBe(2);
    const withdrawn = await svc.withdraw({ businessId: ids.bizA, actorUserId: ids.ownerA });
    expect(withdrawn.status).toBe('withdrawn');
    expect(await svc.isParticipating(ids.bizA)).toBe(false);
    await expect(
      svc.withdraw({ businessId: ids.bizA, actorUserId: ids.ownerA }),
    ).rejects.toMatchObject({ code: 'B2B_PARTICIPATION_WITHDRAWAL_CONFLICT' });
    const event = await client.query(
      `SELECT count(*)::int AS n FROM b2b_participation_events WHERE participation_id=$1 AND event_type='withdrawn'`,
      [withdrawn.id],
    );
    expect(event.rows[0].n).toBe(1);
  });

  it('database guards: immutable fields, no delete/truncate, active terms required, no self-acceptance by the enrolling admin', async () => {
    await sqlFails(
      'DELETE FROM b2b_participations WHERE business_id=$1',
      [ids.bizA],
      /B2B_PARTICIPATION_DELETE_DENIED/,
    );
    await sqlFails(
      'TRUNCATE b2b_participations',
      [],
      /B2B_TRUNCATE_DENIED|cannot truncate a table referenced/,
    );
    await sqlFails(
      `UPDATE b2b_participations SET accepted_by_user_id=$2 WHERE business_id=$1`,
      [ids.bizA, ids.admin],
      /B2B_PARTICIPATION_IMMUTABLE/,
    );
    await sqlFails(
      `UPDATE b2b_participations SET business_id=$2 WHERE business_id=$1`,
      [ids.bizA, ids.bizB],
      /B2B_PARTICIPATION_IMMUTABLE/,
    );
    await sqlFails(
      `UPDATE b2b_participations SET status='left' WHERE business_id=$1`,
      [ids.bizA],
      /b2b_participations_status_check|B2B_PARTICIPATION_TRANSITION_DENIED/,
    );
    await sqlFails(
      `UPDATE b2b_participations SET status='suspended' WHERE business_id=$1`,
      [ids.bizA],
      /b2b_participations_suspension_check/,
    );
    const terms = await client.query<{ id: string }>(
      'SELECT id FROM b2b_terms_versions WHERE version=$1',
      [version],
    );
    await sqlFails(
      `INSERT INTO b2b_participations(business_id,terms_version_id,terms_digest,accepted_by_user_id,accepted_at,enrolled_by_user_id) VALUES($1,$2,$3,$4,now(),$4)`,
      [ids.bizB, terms.rows[0]!.id, DIGEST, ids.admin],
      /B2B_PARTICIPATION_SEPARATE_ACCEPTOR_REQUIRED/,
    );
    await sqlFails(
      `INSERT INTO b2b_participations(business_id,terms_version_id,terms_digest,accepted_by_user_id,accepted_at,enrolled_by_user_id) VALUES($1,$2,$3,$4,now(),$5)`,
      [ids.bizB, terms.rows[0]!.id, 'c'.repeat(64), ids.ownerB, ids.admin],
      /B2B_PARTICIPATION_REQUIRES_ACTIVE_TERMS/,
    );
  });

  it('participation touches no loyalty, points, credit or billing rows', async () => {
    const before = await client.query(
      `SELECT (SELECT count(*) FROM partner_credit_accounts WHERE business_id=$1) AS a, (SELECT count(*) FROM partner_program_enrollments WHERE business_id=$1) AS e`,
      [ids.bizA],
    );
    expect(before.rows[0]).toEqual({ a: '0', e: '0' });
  });
});
