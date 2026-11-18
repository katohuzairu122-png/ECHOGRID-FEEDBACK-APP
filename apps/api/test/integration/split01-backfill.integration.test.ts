import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerMembershipService } from '../../src/customer-relationships/customer-membership.service';
import { buildDb } from '../../src/db/client';

/**
 * Split 01 Definition of Done, "backfill": migration 0034 must turn every
 * pre-existing loyalty account into exactly one membership without touching
 * balances, the ledger or anyone's consent, and must keep doing so through
 * every later migration.
 *
 * CI migrates an empty database, which proves nothing about 0034's backfill, so
 * this suite builds its own scratch database at the 0033 state with the real
 * Drizzle migrator, seeds legacy-shaped rows, applies 0034, then the rest of
 * the journal, and asserts after each stage. It also runs the read-only
 * reconciliation script an operator would run on staging or production.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  const target = new URL(databaseUrl);
  if (
    !['localhost', '127.0.0.1'].includes(target.hostname) ||
    !['/echogrid_test', '/echogrid_ci_pg18', '/echogrid_core_loyalty_test'].includes(
      target.pathname,
    )
  ) {
    throw new Error('Split 01 backfill test requires a disposable loopback PostgreSQL server.');
  }
}

// Fixture identifiers (valid v4-shaped UUIDs; only this scratch database ever contains them).
const BUSINESS_A = 'b1000000-0000-4000-8000-000000000001';
const BUSINESS_B = 'b1000000-0000-4000-8000-000000000002';
const CUSTOMER = {
  active: 'c1000000-0000-4000-8000-000000000001',
  suspended: 'c1000000-0000-4000-8000-000000000002',
  softDeleted: 'c1000000-0000-4000-8000-000000000003',
} as const;
const ACCOUNT_ACTIVE_WITH_BALANCE = 'a1000000-0000-4000-8000-000000000001';

/** One row per legacy account: each flag is a property that migration 0034 promises. */
interface BackfillRow {
  account_id: string;
  same_pair: boolean;
  status_mirrors: boolean;
  suspended_at_consistent: boolean;
  provenance: boolean;
  joined_at_from_account: boolean;
}

/** Legacy-shaped rows as the pre-Split-01 application wrote them. */
const LEGACY_SEED = `
INSERT INTO businesses (id, name, slug) VALUES
  ('${BUSINESS_A}', 'Legacy A', 's01-backfill-a'),
  ('${BUSINESS_B}', 'Legacy B', 's01-backfill-b');
INSERT INTO customers (id, phone) VALUES
  ('${CUSTOMER.active}', '+15550001001'),
  ('${CUSTOMER.suspended}', '+15550001002'),
  ('${CUSTOMER.softDeleted}', '+15550001003'),
  ('c1000000-0000-4000-8000-000000000004', '+15550001004'),
  ('c1000000-0000-4000-8000-000000000005', '+15550001005'),
  ('c1000000-0000-4000-8000-000000000006', '+15550001006');
INSERT INTO loyalty_accounts
  (id, customer_id, business_id, points, status, is_deleted, deleted_at, visit_count, created_at, updated_at, referred_by_customer_id) VALUES
  ('${ACCOUNT_ACTIVE_WITH_BALANCE}', '${CUSTOMER.active}', '${BUSINESS_A}', 120, 'active', false, NULL, 5, '2026-01-10 09:00+00', '2026-02-01 09:00+00', NULL),
  ('a1000000-0000-4000-8000-000000000002', '${CUSTOMER.suspended}', '${BUSINESS_A}', 40, 'suspended', false, NULL, 2, '2026-01-12 09:00+00', '2026-02-03 09:00+00', NULL),
  ('a1000000-0000-4000-8000-000000000003', '${CUSTOMER.softDeleted}', '${BUSINESS_A}', 0, 'active', true, '2026-03-01 00:00+00', 0, '2026-01-15 09:00+00', '2026-03-01 00:00+00', NULL),
  ('a1000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000004', '${BUSINESS_A}', 75, 'active', false, NULL, 3, '2026-01-20 09:00+00', '2026-02-20 09:00+00', '${CUSTOMER.active}'),
  ('a1000000-0000-4000-8000-000000000005', '${CUSTOMER.active}', '${BUSINESS_B}', 10, 'active', false, NULL, 1, '2026-02-10 09:00+00', '2026-02-10 09:00+00', NULL),
  ('a1000000-0000-4000-8000-000000000006', 'c1000000-0000-4000-8000-000000000005', '${BUSINESS_B}', 0, 'active', false, NULL, 0, '2026-02-11 09:00+00', '2026-02-11 09:00+00', NULL),
  ('a1000000-0000-4000-8000-000000000007', 'c1000000-0000-4000-8000-000000000006', '${BUSINESS_B}', 5, 'suspended', true, '2026-03-02 00:00+00', 1, '2026-02-12 09:00+00', '2026-03-02 00:00+00', NULL);
INSERT INTO loyalty_transactions (id, loyalty_account_id, type, points, created_at) VALUES
  ('d1000000-0000-4000-8000-000000000001', '${ACCOUNT_ACTIVE_WITH_BALANCE}', 'checkin', 100, '2026-01-10 09:05+00'),
  ('d1000000-0000-4000-8000-000000000002', '${ACCOUNT_ACTIVE_WITH_BALANCE}', 'adjustment', 20, '2026-01-11 09:05+00'),
  ('d1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000002', 'checkin', 40, '2026-01-12 09:05+00'),
  ('d1000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000004', 'checkin', 75, '2026-01-20 09:05+00'),
  ('d1000000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000005', 'checkin', 10, '2026-02-10 09:05+00'),
  ('d1000000-0000-4000-8000-000000000006', 'a1000000-0000-4000-8000-000000000007', 'checkin', 5, '2026-02-12 09:05+00');
`;

describe.skipIf(!databaseUrl)(
  'Split 01 backfill on legacy-shaped data (disposable PostgreSQL)',
  () => {
    const scratch = `echogrid_split01_backfill_${randomBytes(5).toString('hex')}`;
    const folder = resolve(__dirname, '../../drizzle');
    const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const backfill = journal.entries.find((entry) => entry.tag.startsWith('0034_split01_'));
    const tempFolders: string[] = [];
    let admin: Client;
    let client: Client;
    let service: CustomerMembershipService;

    const urlFor = (database: string) => {
      const url = new URL(databaseUrl!);
      url.pathname = `/${database}`;
      return url.toString();
    };

    /** A copy of the migrations folder whose journal stops at `lastIdx`, so the real migrator can be driven stage by stage. */
    const journalUpTo = (lastIdx: number) => {
      const dir = mkdtempSync(join(tmpdir(), 'echogrid-split01-migrations-'));
      tempFolders.push(dir);
      mkdirSync(join(dir, 'meta'));
      const entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
      writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
      for (const entry of entries)
        writeFileSync(
          join(dir, `${entry.tag}.sql`),
          readFileSync(join(folder, `${entry.tag}.sql`)),
        );
      return dir;
    };
    const migrateTo = (lastIdx: number) =>
      migrate(buildDb(client), { migrationsFolder: journalUpTo(lastIdx) });

    const count = async (statement: string) => Number((await client.query(statement)).rows[0].n);

    /** Accounts, ledger and balances as a single comparable value. */
    const fingerprints = async () => ({
      accounts: (
        await client.query(
          `SELECT md5(string_agg(id || ':' || customer_id || ':' || business_id || ':' || points || ':' || status || ':' ||
                  is_deleted || ':' || visit_count || ':' || created_at::text || ':' || updated_at::text || ':' ||
                  coalesce(referred_by_customer_id::text, '-'), ',' ORDER BY id)) AS fp FROM loyalty_accounts`,
        )
      ).rows[0].fp as string,
      ledger: (
        await client.query(
          `SELECT md5(string_agg(id || ':' || loyalty_account_id || ':' || type || ':' || points || ':' || created_at::text, ',' ORDER BY id)) AS fp
           FROM loyalty_transactions`,
        )
      ).rows[0].fp as string,
      balance: await count('SELECT coalesce(sum(points), 0)::int AS n FROM loyalty_accounts'),
    });

    /** Every property 0034 promises, one row per legacy account; returns the ids that break any of them. */
    const assertBackfill = async () => {
      const rows: BackfillRow[] = (
        await client.query(
          `SELECT la.id AS account_id,
                (m.customer_id = la.customer_id AND m.business_id = la.business_id) AS same_pair,
                (m.status = CASE WHEN la.status = 'suspended' THEN 'suspended' ELSE 'active' END) AS status_mirrors,
                ((m.suspended_at IS NOT NULL) = (m.status = 'suspended')) AS suspended_at_consistent,
                (m.onboarding_source = 'legacy_migration' AND m.onboarding_reference = la.id::text) AS provenance,
                (m.joined_at = la.created_at AND NOT m.is_deleted) AS joined_at_from_account
           FROM loyalty_accounts la
           JOIN business_customer_memberships m ON m.id = la.membership_id
          ORDER BY la.id`,
        )
      ).rows;
      expect(rows).toHaveLength(7);
      expect(
        rows
          .filter(
            (r) =>
              !(
                r.same_pair &&
                r.status_mirrors &&
                r.suspended_at_consistent &&
                r.provenance &&
                r.joined_at_from_account
              ),
          )
          .map((r) => r.account_id),
      ).toEqual([]);
      expect(
        await count('SELECT count(*)::int AS n FROM loyalty_accounts WHERE membership_id IS NULL'),
      ).toBe(0);
      expect(await count('SELECT count(*)::int AS n FROM business_customer_memberships')).toBe(7);
      // A relationship is recorded, never a consent or an authorization the customer did not give.
      expect(await count('SELECT count(*)::int AS n FROM consent_grants')).toBe(0);
      expect(await count('SELECT count(*)::int AS n FROM customer_action_authorizations')).toBe(0);
    };

    const reconcile = () => {
      const run = spawnSync(
        process.execPath,
        [resolve(__dirname, '../../scripts/split01-reconcile.mjs')],
        {
          env: { ...process.env, DATABASE_URL: urlFor(scratch) },
          encoding: 'utf8',
        },
      );
      return {
        status: run.status,
        stderr: run.stderr,
        report: JSON.parse(run.stdout || 'null') as null | {
          ok: boolean;
          counts: Record<string, number>;
          violations: { check: string; count: number }[];
        },
      };
    };

    let legacy: Awaited<ReturnType<typeof fingerprints>>;

    beforeAll(async () => {
      expect(backfill, 'the journal must contain the Split 01 migration').toBeDefined();
      admin = new Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${scratch}`);
      client = new Client({ connectionString: urlFor(scratch) });
      await client.connect();
      service = new CustomerMembershipService(buildDb(client));

      await migrateTo(backfill!.idx - 1);
      expect(
        await count(
          "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'business_customer_memberships'",
        ),
      ).toBe(0);
      await client.query(LEGACY_SEED);
      legacy = await fingerprints();
      expect(legacy.balance).toBe(250);
    }, 120_000);

    afterAll(async () => {
      await client?.end().catch(() => undefined);
      await admin?.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch(() => undefined);
      await admin?.end().catch(() => undefined);
      for (const dir of tempFolders) rmSync(dir, { recursive: true, force: true });
    }, 60_000);

    it('0034 maps every legacy account to exactly one membership and leaves accounts, ledger and balances untouched', async () => {
      await migrateTo(backfill!.idx);
      await assertBackfill();
      expect(await fingerprints()).toEqual(legacy);
    }, 120_000);

    it('the backfill and the untouched balances survive every later migration', async () => {
      await migrateTo(Number.MAX_SAFE_INTEGER);
      await assertBackfill();
      expect(await fingerprints()).toEqual(legacy);
    }, 120_000);

    it('the read-only reconciliation reports the one soft-deleted account the backfill cannot judge', () => {
      const { status, report } = reconcile();
      expect(status).toBe(1);
      expect(report?.counts).toMatchObject({
        accounts_total: 7,
        memberships_total: 7,
        legacy_memberships: 7,
        accounts_without_membership: 0,
        mapping_mismatch: 0,
        status_disagreement: 0,
        memberships_without_account: 0,
        joined_without_active_consent: 0,
        left_with_active_consent: 0,
      });
      expect(report?.violations.map((v) => `${v.check}=${v.count}`)).toEqual([
        'deleted_account_active_membership=1',
      ]);
    });

    it('a legacy member who scans the QR after the migration keeps the same membership, account and balance and gains one consent', async () => {
      const input = {
        customerId: CUSTOMER.active,
        businessId: BUSINESS_A,
        onboardingSource: 'business_qr',
        onboardingReference: 'legacy-member-scan',
        consentVersion: 'v1' as const,
      };
      const first = await service.join(input);
      const replay = await service.join(input);

      expect(replay.membership.id).toBe(first.membership.id);
      expect(first.membership.onboardingSource).toBe('legacy_migration');
      expect(first.loyaltyAccount.id).toBe(ACCOUNT_ACTIVE_WITH_BALANCE);
      expect(first.loyaltyAccount.points).toBe(120);
      expect(await count('SELECT count(*)::int AS n FROM business_customer_memberships')).toBe(7);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM consent_grants
          WHERE customer_id = '${CUSTOMER.active}' AND business_id = '${BUSINESS_A}' AND purpose = 'join_loyalty' AND status = 'active'`,
        ),
      ).toBe(1);
    });

    it('a legacy suspended member cannot reactivate themselves by joining again', async () => {
      await expect(
        service.join({
          customerId: CUSTOMER.suspended,
          businessId: BUSINESS_A,
          onboardingSource: 'business_qr',
          onboardingReference: 'legacy-suspended-scan',
          consentVersion: 'v1',
        }),
      ).rejects.toMatchObject({ status: 409, code: 'MEMBERSHIP_NOT_REACTIVATABLE' });
      expect(
        await count(
          `SELECT count(*)::int AS n FROM consent_grants WHERE customer_id = '${CUSTOMER.suspended}'`,
        ),
      ).toBe(0);
    });

    it('a soft-deleted legacy account is refused with a clean 409 and leaves no consent behind', async () => {
      await expect(
        service.join({
          customerId: CUSTOMER.softDeleted,
          businessId: BUSINESS_A,
          onboardingSource: 'business_qr',
          onboardingReference: 'legacy-deleted-scan',
          consentVersion: 'v1',
        }),
      ).rejects.toMatchObject({ status: 409, code: 'LOYALTY_ACCOUNT_UNAVAILABLE' });
      expect(
        await count(
          `SELECT count(*)::int AS n FROM consent_grants WHERE customer_id = '${CUSTOMER.softDeleted}'`,
        ),
      ).toBe(0);
    });

    it('once an operator has reviewed the soft-deleted rows the reconciliation passes', async () => {
      await client.query(
        'UPDATE loyalty_accounts SET is_deleted = false, deleted_at = NULL WHERE is_deleted',
      );
      const { status, report } = reconcile();
      expect(report?.violations).toEqual([]);
      expect(report?.ok).toBe(true);
      expect(status).toBe(0);
    });
  },
);
