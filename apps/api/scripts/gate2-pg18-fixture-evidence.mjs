/**
 * Gate 2 R4: synthetic multi-tenant fixture preservation & disposable restore.
 * Only CI service-container databases and explicit test identifiers.
 */
import pg from 'pg';
const action = process.argv[2];
if (!['seed', 'verify'].includes(action)) throw new Error('GATE2_R4_ACTION_DENIED');
const target = process.env.DATABASE_URL;
const allowed = new Set([
  'postgresql://echogrid:echogrid@localhost:5432/echogrid_ci_pg18_upgrade',
  'postgresql://echogrid:echogrid@localhost:5432/echogrid_ci_pg18_restored',
]);
if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GATE2_SYNTHETIC_UPGRADE !== 'I_ACKNOWLEDGE_DISPOSABLE_PG18' ||
    !allowed.has(target) || (action === 'seed' && !target.endsWith('/echogrid_ci_pg18_upgrade'))) {
  throw new Error('GATE2_R4_DISPOSABLE_TARGET_DENIED');
}
const businesses = [
  ['a4000000-0000-4000-8000-000000000001', 'gate2-r4-synthetic-business-one'],
  ['a4000000-0000-4000-8000-000000000002', 'gate2-r4-synthetic-business-two'],
];
const branches = [
  ['b4000000-0000-4000-8000-000000000001', businesses[0][0], 'gate2-r4-one'],
  ['b4000000-0000-4000-8000-000000000002', businesses[1][0], 'gate2-r4-two'],
];
const customers = [
  ['c4000000-0000-4000-8000-000000000001', '+15550009101'],
  ['c4000000-0000-4000-8000-000000000002', '+15550009102'],
];
const accounts = [
  ['d4000000-0000-4000-8000-000000000001', customers[0][0], businesses[0][0]],
  ['d4000000-0000-4000-8000-000000000002', customers[1][0], businesses[1][0]],
];
const db = new pg.Client({ connectionString: target });
try {
  await db.connect();
  const env = (await db.query("SELECT current_database() db, current_user AS role, current_setting('server_version_num')::int AS version")).rows[0];
  if (!['echogrid_ci_pg18_upgrade', 'echogrid_ci_pg18_restored'].includes(env.db) ||
      env.role !== 'echogrid' || Math.floor(env.version / 10000) !== 18) {
    throw new Error('GATE2_R4_DATABASE_MISMATCH');
  }
  const migrationCount = Number((await db.query(
    'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
  )).rows[0]?.count);
  const expectedMigrationCount = action === 'seed' || env.db.endsWith('_restored') ? 45 : 67;
  if (migrationCount !== expectedMigrationCount) throw new Error('GATE2_R4_MIGRATION_PHASE_MISMATCH');
  if (action === 'seed') {
    await db.query('BEGIN');
    try {
      for (const [id, slug] of businesses) await db.query(
        'INSERT INTO public.businesses (id,name,slug) VALUES ($1,$2,$3)',
        [id, 'Gate 2 R4 synthetic tenant', slug],
      );
      for (const [id, businessId, slug] of branches) await db.query(
        'INSERT INTO public.branches (id,business_id,name,slug) VALUES ($1,$2,$3,$4)',
        [id, businessId, 'Synthetic branch', slug],
      );
      for (const [id, phone] of customers) await db.query(
        'INSERT INTO public.customers (id,phone) VALUES ($1,$2)', [id,phone],
      );
      for (const [id, customerId, businessId] of accounts) await db.query(
        'INSERT INTO public.loyalty_accounts (id,customer_id,business_id) VALUES ($1,$2,$3)',
        [id,customerId,businessId],
      );
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  }
  const checks = [
    ['businesses', 'id', businesses],
    ['branches', 'id', branches],
    ['customers', 'id', customers],
    ['loyalty_accounts', 'id', accounts],
  ];
  for (const [table, column, fixtures] of checks) {
    const ids = fixtures.map(r => r[0]);
    const rows = (await db.query(
      `SELECT ${column}::text AS id FROM public.${table} WHERE ${column} = ANY($1::uuid[]) ORDER BY id`,
      [ids],
    )).rows.map(r => r.id);
    if (rows.length !== 2 || rows.some((id, i) => id !== [...ids].sort()[i])) {
      throw new Error('GATE2_R4_FIXTURE_PRESERVATION_FAILED_' + table);
    }
  }
  const tenantRows = (await db.query(
    `SELECT a.id::text AS id, a.customer_id::text AS customer,
      a.business_id::text AS business, a.points, a.visit_count,
      b.id::text AS valid_business
      FROM public.loyalty_accounts a JOIN public.businesses b ON b.id=a.business_id
      WHERE a.id = ANY($1::uuid[]) ORDER BY a.id`,
    [accounts.map(r => r[0])],
  )).rows;
  if (tenantRows.length !== 2 || tenantRows.some((r,i) =>
    r.id !== accounts[i][0] || r.customer !== accounts[i][1] ||
    r.business !== accounts[i][2] || r.valid_business !== r.business ||
    r.points !== 0 || r.visit_count !== 0)) {
    throw new Error('GATE2_R4_TENANT_FIDELITY_FAILED');
  }
  console.log(JSON.stringify({
    gate:'GATE2_R4_SYNTHETIC_RECORD_PRESERVATION',
    phase:action, result:'PASS', databaseKind:env.db.endsWith('_restored')?'DISPOSABLE_RESTORED':'DISPOSABLE_UPGRADE',
    syntheticBusinesses:2, syntheticBranches:2, syntheticCustomers:2, syntheticLoyaltyAccounts:2,
    stagingVerified:false, backupPolicyCertified:false, migrationAuthorized:false,
    financialAuthorization:'NOT_GRANTED',
  }));
} finally { await db.end().catch(() => undefined); }
