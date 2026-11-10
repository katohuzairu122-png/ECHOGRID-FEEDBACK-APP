/**
 * Gate 2 R21 — READ-ONLY pre-check of existing cross-tenant foreign-key references.
 *
 * Counts, per single-column foreign key between two tenant-owned tables (both carry business_id), the rows whose child and parent belong to different tenants or lack a tenant. It is the data pre-check for the
 * composite tenant-key migration designed in docs/architecture/builds/SPLIT-08/GATE2_R21_COMPOSITE_TENANT_KEY_DESIGN.md. It changes nothing: it opens ONE read-only transaction (verified before any query), sets short
 * statement and lock timeouts, runs only SELECT, and prints COUNTS ONLY by default (never row contents, never the connection string).
 *
 *   DATABASE_URL=... node scripts/gate2-tenant-reference-precheck.mjs --label disposable|staging|production [--sample N]
 *
 * Exit codes: 0 no violations found and the specification covers the catalog; 1 violations found; 2 the specification no longer matches the catalog (a foreign key is unclassified, stale or mis-classified); 3 a safety check failed.
 * Running it against staging or production is the OWNER's decision: this repository run never does.
 */
import pg from 'pg';
import { fileURLToPath } from 'node:url';

/** child, parent, FK column, class. Every uncovered single-column tenant-to-tenant FK must appear here (the coverage check fails otherwise). */
export const SPEC = [
  ['ai_usage_log', 'branches', 'branch_id', 'STRAIGHT'],
  ['community_point_transactions', 'branches', 'branch_id', 'NULLABLE_TENANT_DECISION'],
  ['community_point_transactions', 'community_point_transactions', 'reversal_of', 'SELF_REFERENCE'],
  ['critical_incidents', 'branches', 'branch_id', 'STRAIGHT'],
  ['critical_incidents', 'feedback', 'feedback_id', 'STRAIGHT'],
  ['feedback', 'branches', 'branch_id', 'STRAIGHT'],
  ['feedback', 'qr_codes', 'qr_code_id', 'STRAIGHT'],
  ['feedback_summaries', 'branches', 'branch_id', 'STRAIGHT'],
  ['fraud_signals', 'branches', 'branch_id', 'STRAIGHT'],
  ['fraud_signals', 'feedback', 'feedback_id', 'STRAIGHT'],
  ['loyalty_accounts', 'business_customer_memberships', 'membership_id', 'STRAIGHT'],
  ['loyalty_accounts', 'loyalty_tiers', 'tier_id', 'OPTIONAL_FK_SET_NULL'],
  ['loyalty_purchase_events', 'branches', 'branch_id', 'OPTIONAL_FK_SET_NULL'],
  ['loyalty_purchase_events', 'business_customer_memberships', 'membership_id', 'STRAIGHT'],
  ['loyalty_purchase_events', 'loyalty_accounts', 'loyalty_account_id', 'STRAIGHT'],
  ['loyalty_rewards', 'branches', 'branch_id', 'STRAIGHT'],
  ['partner_credit_multiunit_lot_allocations', 'partner_credit_accounts', 'account_id', 'FINANCIAL_DEFER'],
  ['partner_credit_multiunit_lot_allocations', 'partner_credit_award_decisions', 'decision_id', 'FINANCIAL_DEFER'],
  ['qr_codes', 'branches', 'branch_id', 'STRAIGHT'],
  ['qr_scan_events', 'branches', 'branch_id', 'STRAIGHT'],
  ['qr_scan_events', 'qr_codes', 'qr_code_id', 'STRAIGHT'],
  ['signed_evidence_events', 'signed_evidence_records', 'evidence_id', 'GUARDED_BY_TRIGGER', 'evidence_id'],
  ['survey_campaigns', 'branches', 'branch_id', 'NULLABLE_TENANT_DECISION'],
  ['survey_campaigns', 'surveys', 'survey_id', 'NULLABLE_TENANT_DECISION'],
  ['survey_participations', 'branches', 'branch_id', 'NULLABLE_TENANT_DECISION'],
  ['survey_participations', 'consent_grants', 'consent_grant_id', 'NULLABLE_TENANT_DECISION'],
  ['survey_participations', 'survey_campaigns', 'campaign_id', 'NULLABLE_TENANT_DECISION'],
  ['survey_participations', 'surveys', 'survey_id', 'NULLABLE_TENANT_DECISION'],
  ['team_invitations', 'branches', 'branch_id', 'STRAIGHT'],
  ['team_invitations', 'roles', 'role_id', 'STRAIGHT'],
  ['user_business_roles', 'branches', 'branch_id', 'STRAIGHT'],
  ['user_business_roles', 'roles', 'role_id', 'STRAIGHT'],
  ['visit_sessions', 'branches', 'branch_id', 'STRAIGHT'],
].map(([child, parent, column, cls, parentKey = 'id']) => Object.freeze({ child, parent, column, cls, parentKey }));

const IDENT = /^[a-z][a-z0-9_]{0,62}$/;
const key = e => `${e.child}|${e.parent}|${e.column}`;

/** Uncovered single-column FKs between tenant-owned tables, with the facts the classification depends on. Read-only catalog query. */
export const INVENTORY_SQL = `
WITH tenant AS (
  SELECT c.oid, c.relname, a.attnotnull AS biz_notnull FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='business_id' AND NOT a.attisdropped WHERE n.nspname='public' AND c.relkind='r'),
fk AS (
  SELECT con.oid, con.conrelid, con.confrelid, con.conkey, con.confkey, con.confdeltype, con.convalidated,
    (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.attnum) AS cols,
    (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.attnum) AS parent_cols
  FROM pg_constraint con WHERE con.contype='f' AND con.connamespace='public'::regnamespace)
SELECT s.relname AS child, t.relname AS parent, f.cols AS "column", f.parent_cols,
  CASE f.confdeltype WHEN 'n' THEN 'SET NULL' WHEN 'c' THEN 'CASCADE' WHEN 'r' THEN 'RESTRICT' WHEN 'a' THEN 'NO ACTION' ELSE 'OTHER' END AS on_delete,
  s.biz_notnull AS child_biz_notnull, t.biz_notnull AS parent_biz_notnull, (f.conrelid = f.confrelid) AS self_ref,
  EXISTS (SELECT 1 FROM fk g WHERE g.conrelid=f.conrelid AND g.confrelid=f.confrelid AND g.oid<>f.oid AND g.convalidated -- a NOT VALID composite key says nothing about rows that already exist
            AND EXISTS (SELECT 1 FROM unnest(g.conkey) k(attnum) JOIN pg_attribute a ON a.attrelid=g.conrelid AND a.attnum=k.attnum WHERE a.attname='business_id')
            AND (SELECT array_agg(a.attname) FROM unnest(f.conkey) k(attnum) JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=k.attnum)
                <@ (SELECT array_agg(a.attname) FROM unnest(g.conkey) k(attnum) JOIN pg_attribute a ON a.attrelid=g.conrelid AND a.attnum=k.attnum)) AS covered
FROM fk f JOIN tenant s ON s.oid=f.conrelid JOIN tenant t ON t.oid=f.confrelid
WHERE array_length(f.conkey,1)=1 AND NOT EXISTS (SELECT 1 FROM unnest(f.conkey) k(attnum) JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=k.attnum WHERE a.attname='business_id')
ORDER BY 1,2,3`;

const consistent = (e, r) => {
  const bothNotNull = r.child_biz_notnull && r.parent_biz_notnull;
  switch (e.cls) {
    case 'STRAIGHT': return bothNotNull && r.on_delete !== 'SET NULL';
    case 'OPTIONAL_FK_SET_NULL': return bothNotNull && r.on_delete === 'SET NULL';
    case 'NULLABLE_TENANT_DECISION': return !bothNotNull;
    case 'SELF_REFERENCE': return r.self_ref;
    default: return true; // FINANCIAL_DEFER and GUARDED_BY_TRIGGER are policy classes, not catalog facts
  }
};

/** Does the specification still describe the catalog? Pure comparison; no data is read. */
export function coverage(rows) {
  const byKey = new Map(rows.filter(r => !r.covered).map(r => [`${r.child}|${r.parent}|${r.column}`, r]));
  const covered = rows.filter(r => r.covered).map(r => `${r.child}|${r.parent}|${r.column}`);
  const specKeys = new Set(SPEC.map(key));
  const unclassified = [...byKey.keys()].filter(k => !specKeys.has(k));
  const stale = SPEC.filter(e => !byKey.has(key(e))).map(key);
  const inconsistent = SPEC.filter(e => byKey.has(key(e)) && !consistent(e, byKey.get(key(e)))).map(key);
  const notIdParent = SPEC.filter(e => byKey.has(key(e)) && byKey.get(key(e)).parent_cols !== e.parentKey).map(key); // the referenced key column must be the one the specification names
  return { unclassified, stale, inconsistent, notIdParent, covered, ok: !unclassified.length && !stale.length && !inconsistent.length && !notIdParent.length };
}

const countSql = e => {
  for (const id of [e.child, e.parent, e.column, e.parentKey]) if (!IDENT.test(id)) throw Error('PRECHECK_BAD_IDENTIFIER');
  return `SELECT
    count(*) FILTER (WHERE c.business_id IS NOT NULL AND p.business_id IS NOT NULL AND c.business_id <> p.business_id)::int AS tenant_mismatch,
    count(*) FILTER (WHERE c.business_id IS NULL)::int AS child_untenanted,
    count(*) FILTER (WHERE p.business_id IS NULL)::int AS parent_untenanted,
    count(*)::int AS referencing_rows
  FROM public."${e.child}" c JOIN public."${e.parent}" p ON p."${e.parentKey}" = c."${e.column}" WHERE c."${e.column}" IS NOT NULL`;
};

/** Runs the whole pre-check on an already-connected client inside ONE read-only transaction. */
export async function runPrecheck(client, { label, sample = 0 } = {}) {
  if (!['disposable', 'staging', 'production'].includes(label)) throw Error('PRECHECK_LABEL_REQUIRED');
  if (!Number.isInteger(sample) || sample < 0 || sample > 20) throw Error('PRECHECK_SAMPLE_RANGE');
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '60s'"); await client.query("SET LOCAL lock_timeout = '2s'");
    const ro = (await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only;
    if (ro !== 'on') { const e = Error('PRECHECK_NOT_READ_ONLY'); e.exit = 3; throw e; }
    const version = (await client.query("SELECT current_setting('server_version_num')::int AS v")).rows[0].v;
    const inv = (await client.query(INVENTORY_SQL)).rows;
    const cov = coverage(inv);
    const entries = [];
    for (const e of SPEC) {
      if (!inv.some(r => !r.covered && `${r.child}|${r.parent}|${r.column}` === key(e))) continue; // stale entries are reported by coverage, not queried
      const r = (await client.query(countSql(e))).rows[0];
      const out = { child: e.child, parent: e.parent, column: e.column, class: e.cls, referencingRows: r.referencing_rows, tenantMismatch: r.tenant_mismatch, childUntenanted: r.child_untenanted, parentUntenanted: r.parent_untenanted };
      if (sample > 0 && (r.tenant_mismatch > 0)) {
        out.sampleChildIds = (await client.query(`SELECT c.id::text AS id FROM public."${e.child}" c JOIN public."${e.parent}" p ON p."${e.parentKey}" = c."${e.column}" WHERE c.business_id IS NOT NULL AND p.business_id IS NOT NULL AND c.business_id <> p.business_id ORDER BY c.id LIMIT ${sample}`)).rows.map(x => x.id);
      }
      entries.push(out);
    }
    const mismatching = entries.filter(x => x.tenantMismatch > 0);
    const result = {
      gate: 'GATE2_R21_TENANT_REFERENCE_PRECHECK', label, serverVersionNum: version, readOnlyTransaction: true, countsOnly: sample === 0,
      checkedForeignKeys: entries.length, coveredByExistingComposite: cov.covered.length, specificationCoversCatalog: cov.ok, coverage: cov,
      totals: { tenantMismatch: entries.reduce((s, x) => s + x.tenantMismatch, 0), childUntenanted: entries.reduce((s, x) => s + x.childUntenanted, 0), parentUntenanted: entries.reduce((s, x) => s + x.parentUntenanted, 0), referencingRows: entries.reduce((s, x) => s + x.referencingRows, 0) },
      mismatching: mismatching.map(x => `${x.child}.${x.column}->${x.parent}`),
      entries,
      verdict: !cov.ok ? 'SPECIFICATION_DRIFT' : mismatching.length ? 'VIOLATIONS_FOUND' : 'NO_TENANT_MISMATCH_FOUND',
      note: 'child_untenanted / parent_untenanted rows are NOT mismatches: they belong to the nullable-tenant owner decision in the design document. A clean result proves nothing about rows written after this run.',
    };
    await client.query('ROLLBACK');
    return result;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = n => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : undefined; };
  const label = arg('--label'); const sample = arg('--sample') === undefined ? 0 : Number(arg('--sample'));
  if (!process.env.DATABASE_URL) { console.error('PRECHECK_DATABASE_URL_REQUIRED'); process.exit(3); }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'gate2_r21_readonly_precheck' });
  try {
    await client.connect();
    const out = await runPrecheck(client, { label, sample });
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = out.verdict === 'NO_TENANT_MISMATCH_FOUND' ? 0 : out.verdict === 'VIOLATIONS_FOUND' ? 1 : 2;
  } catch (e) { console.error(String(e.message ?? e).slice(0, 200)); process.exitCode = e.exit ?? 3; }
  finally { await client.end().catch(() => {}); }
}
