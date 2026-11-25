import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildDb } from '../../src/db/client';

/**
 * TB-04 migration and compatibility acceptance on a DISPOSABLE database: legacy Community Points, business loyalty points, customers and
 * businesses seeded at the 0095 schema survive migrations 0096 and 0097 byte-for-byte; the new tables arrive empty with their guards; the
 * documented rollback removes exactly what was added; and the upgrade can be applied again. Nothing here touches a shared database.
 */
describe.skipIf(!process.env.DATABASE_URL)('Batch 03 upgrade 0095 -> 0097 with legacy and badge data', () => {
  const token = randomBytes(5).toString('hex');
  const dbName = `echogrid_b03_${token}`;
  const folder = resolve(__dirname, '../../drizzle');
  const rollbackSql = readFileSync(resolve(__dirname, '../../../../docs/architecture/builds/TENTASHIP/rollback/0096_0097_rollback.sql'), 'utf8');
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
  const first = journal.entries.find((e) => e.tag === '0096_customer_invitations')!;
  const NEW_TABLES = ['customer_invitations', 'qualification_rule_versions', 'qualification_evidence_consumptions', 'customer_referrals', 'customer_referral_events'];
  const LEGACY = ['customers', 'businesses', 'users', 'loyalty_accounts', 'community_point_accounts', 'community_point_rules', 'community_point_award_decisions', 'tentaship_badge_definitions', 'tentaship_badge_awards', 'business_closure_requests', 'customer_onboarding_events'];
  let admin: Client; let c: Client; const dirs: string[] = [];
  const url = (db: string) => { const u = new URL(process.env.DATABASE_URL!); u.pathname = '/' + db; return u.toString(); };
  const folderUpTo = (lastIdx: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'echogrid-tb04-'));
    dirs.push(dir); mkdirSync(join(dir, 'meta'));
    const entries = journal.entries.filter((e) => e.idx <= lastIdx);
    writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const e of entries) writeFileSync(join(dir, e.tag + '.sql'), readFileSync(join(folder, e.tag + '.sql')));
    return dir;
  };
  const upgrade = (path: string) => migrate(buildDb(c), { migrationsFolder: path });
  const fingerprint = async () => Object.fromEntries(await Promise.all(LEGACY.map(async (t) =>
    [t, (await c.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(to_json(t)::text, ',' ORDER BY id::text), '')) AS h FROM ${t} t`)).rows[0]] as const)));
  const tables = async () => (await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`)).rows.map((r) => r.table_name as string);

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    c = new Client({ connectionString: url(dbName) }); await c.connect();
  });
  afterAll(async () => {
    await c?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  // The probe customer created post-upgrade is test data, not a rollback artefact: compare every legacy table except customers.
  const strip = ({ customers: _customers, ...rest }: Awaited<ReturnType<typeof fingerprint>>) => rest;
  let before: Awaited<ReturnType<typeof fingerprint>>; let tablesBefore: string[];

  it('0095 baseline: install, then seed legacy, badge and closure data', async () => {
    await upgrade(folderUpTo(first.idx - 1));
    expect(await tables()).not.toContain('customer_invitations');
    expect(await tables()).toContain('tentaship_badge_awards');
    const user = (await c.query(`INSERT INTO users (email, full_name, password_hash, status) VALUES ($1,'Legacy','x','active') RETURNING id`, [`tb04-${token}@example.test`])).rows[0].id;
    const biz = (await c.query(`INSERT INTO businesses (name, slug) VALUES ('Legacy Cafe', $1) RETURNING id`, [`tb04-${token}`])).rows[0].id;
    const cust = (await c.query(`INSERT INTO customers (phone) VALUES ('+15598765432') RETURNING id`)).rows[0].id;
    await c.query(`INSERT INTO loyalty_accounts (customer_id, business_id, points) VALUES ($1,$2,120)`, [cust, biz]);
    const acct = (await c.query(`INSERT INTO community_point_accounts (customer_id, points_balance) VALUES ($1, 40) RETURNING id`, [cust])).rows[0].id;
    const rule = (await c.query(`INSERT INTO community_point_rules (source_type, version, status, points, activated_at) VALUES ('survey_completion', 1, 'active', 40, now()) RETURNING id`)).rows[0].id;
    await c.query(`INSERT INTO community_point_award_decisions (customer_id, account_id, source_type, source_ref, rule_id, status, points) VALUES ($1,$2,'survey_completion','legacy-ref',$3,'awarded',40)`, [cust, acct, rule]);
    // Badge and closure data created at 0095 must also survive (TB-02/BIZ-CLOSE-01 ledgers).
    await c.query(`INSERT INTO tentaship_badge_definitions (key, participant_type, created_by_user_id) VALUES ('baseline_badge','customer',$1)`, [user]);
    await c.query(`INSERT INTO business_closure_requests (business_id, requested_by_user_id, obligations_snapshot) VALUES ($1,$2,'{}')`, [biz, user]);
    before = await fingerprint(); tablesBefore = await tables();
    expect(before.loyalty_accounts!.n).toBe(1); expect(before.community_point_accounts!.n).toBe(1); expect(before.community_point_award_decisions!.n).toBe(1);
  });

  it('upgrading to 0097 preserves every legacy row byte-for-byte and adds only the new, empty, guarded tables', async () => {
    await upgrade(folder);
    expect(await fingerprint()).toEqual(before);
    const after = await tables();
    expect(after.filter((t) => !tablesBefore.includes(t)).sort()).toEqual([...NEW_TABLES].sort());
    for (const t of NEW_TABLES) expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
    // guards arrived enabled-always
    const guards = (await c.query(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = ANY($1::regclass[]) AND NOT tgisinternal ORDER BY tgname`, [NEW_TABLES])).rows;
    expect(guards.length).toBeGreaterThanOrEqual(9);
    expect(guards.every((g) => g.tgenabled === 'A')).toBe(true);
    // the new tables arrive with their guards and work on the upgraded database; legacy data is still byte-identical
    const cust = (await c.query(`SELECT id FROM customers LIMIT 1`)).rows[0].id;
    const u = (await c.query(`SELECT id FROM users LIMIT 1`)).rows[0].id;
    const biz = (await c.query(`SELECT id FROM businesses LIMIT 1`)).rows[0].id;
    const cust2 = (await c.query(`INSERT INTO customers (phone) VALUES ('+15598765499') RETURNING id`)).rows[0].id;
    const ref = (await c.query(`INSERT INTO customer_referrals (referral_type, referring_customer_id, referred_customer_id, provenance_kind, provenance_ref) VALUES ('customer_referral',$1,$2,'customer_referral_token','p1') RETURNING id`, [cust, cust2])).rows[0].id;
    await c.query(`INSERT INTO customer_referral_events (referral_id, seq, event_type) VALUES ($1,1,'attributed')`, [ref]);
    await expect(c.query(`INSERT INTO customer_referral_events (referral_id, seq, event_type, rule_version_id) VALUES ($1,2,'verified',NULL)`, [ref])).rejects.toThrow();
    await expect(c.query(`DELETE FROM customer_referrals`)).rejects.toThrow(/APPEND_ONLY/);
    void u; void biz;
    const { customers: _c, ...afterRest } = await fingerprint();
    const { customers: _b, ...beforeRest } = before;
    expect(afterRest).toEqual(beforeRest);
  });

  it('the documented rollback removes exactly what 0096/0097 added, leaves legacy data and the 0095 schema as they were, and the upgrade re-applies', async () => {
    // The probe rows above are test data created after the upgrade; the rollback script is the unit under test.
    await c.query(rollbackSql);
    expect(await tables()).toEqual(tablesBefore);
    expect(strip(await fingerprint())).toEqual(strip(before));
    for (const fn of ['customer_invitations_guard', 'qualification_append_only', 'qualification_rule_versions_guard', 'customer_referral_events_guard']) {
      expect((await c.query(`SELECT 1 FROM pg_proc WHERE proname = $1`, [fn])).rows, fn).toHaveLength(0); // added by 0096/0097: gone
    }
    for (const fn of ['tentaship_badge_versions_guard', 'tentaship_badge_append_only', 'business_closure_requests_guard']) {
      expect((await c.query(`SELECT 1 FROM pg_proc WHERE proname = $1`, [fn])).rows, fn).toHaveLength(1); // 0094/0095 objects: untouched
    }
    // Ledger bookkeeping per the script header: remove the two newest drizzle rows, then upgrade again.
    await c.query(`DELETE FROM drizzle.__drizzle_migrations WHERE id IN (SELECT id FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 2)`);
    await upgrade(folder);
    expect((await tables()).filter((t) => !tablesBefore.includes(t)).sort()).toEqual([...NEW_TABLES].sort());
    expect(strip(await fingerprint())).toEqual(strip(before));
  });
});
