/**
 * Gate 2 R21 — disposable self-test of the read-only tenant-reference pre-check AND of the proposed composite-key pattern.
 *
 * Disposable CI only. Creates synthetic tenants in a database the workflow just created, proves the pre-check (a) counts exactly the injected violations, (b) is read-only, counts-only by default and needs only SELECT,
 * (c) fails closed when the specification drifts from the catalog; then proves the composite-key pattern designed in GATE2_R21_COMPOSITE_TENANT_KEY_DESIGN.md (unique parent key, NOT VALID then VALIDATE,
 * column-list SET NULL) against PostgreSQL 18. No Drizzle migration is added; nothing here touches Neon, staging or production.
 */
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SPEC, runPrecheck } from './gate2-tenant-reference-precheck.mjs';

const DB_URL = 'postgresql://echogrid:echogrid@localhost:5432/echogrid_ci_pg18_r21';
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GATE2_R21_DISPOSABLE !== 'I_ACKNOWLEDGE_DISPOSABLE_PG18' || process.env.DATABASE_URL !== DB_URL) throw Error('GATE2_R21_NON_DISPOSABLE_TARGET_DENIED');

const id = (n, k) => `${k}8100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = id(1, 'a'), B = id(2, 'a');
const BR = { [A]: id(1, 'b'), [B]: id(2, 'b') }, QR = { [A]: id(1, 'e'), [B]: id(2, 'e') }, FB = { [A]: id(1, 'f'), [B]: id(2, 'f') };
const PLATFORM_SURVEY = id(1, 'd'), PLATFORM_SV = id(1, '5'), PLATFORM_CAMPAIGN = id(1, 'c');
const BAD_FB1 = id(11, 'f'), BAD_FB2 = id(12, 'f'), BAD_INC = id(13, 'c'), BAD_REWARD = id(14, 'a');
let checks = 0;
const check = (ok, code) => { checks++; if (!ok) throw Error('GATE2_R21_' + code); };
const owner = new pg.Client({ connectionString: DB_URL });
const attempt = async (c, text, params = []) => { try { const r = await c.query(text, params); return { ok: true, rows: r.rows, rowCount: r.rowCount }; } catch (e) { return { ok: false, code: e.code, message: String(e.message) }; } };
const asLogin = async (name, password, run) => { const u = new URL(DB_URL); u.username = name; u.password = password; const c = new pg.Client({ connectionString: u.toString() }); try { await c.connect(); return await run(c); } finally { await c.end().catch(() => {}); } };
const entry = (res, child, parent, column) => res.entries.find(e => e.child === child && e.parent === parent && e.column === column);

try {
  await owner.connect();
  const info = (await owner.query("SELECT current_database() db,current_user username,current_setting('server_version_num')::int version")).rows[0];
  check(info.db === 'echogrid_ci_pg18_r21' && info.username === 'echogrid' && Math.floor(info.version / 10000) === 18, 'DATABASE_IDENTITY');
  check((await owner.query('SELECT count(*)::int n FROM drizzle.__drizzle_migrations')).rows[0].n === 68, 'MIGRATION_COUNT');

  // ---- fixtures: two tenants, one platform-owned survey campaign (no tenant) ----
  await owner.query('BEGIN');
  for (const [i, b] of [A, B].entries()) {
    await owner.query('INSERT INTO public.businesses(id,name,slug) VALUES($1,$2,$3)', [b, 'R21 synthetic ' + i, 'r21-' + i]);
    await owner.query('INSERT INTO public.branches(id,business_id,name,slug) VALUES($1,$2,$3,$4)', [BR[b], b, 'R21 branch', 'r21-branch']);
    await owner.query('INSERT INTO public.qr_codes(id,business_id,branch_id) VALUES($1,$2,$3)', [QR[b], b, BR[b]]);
    await owner.query('INSERT INTO public.feedback(id,business_id,branch_id,qr_code_id,rating,comment) VALUES($1,$2,$3,$4,5,$5)', [FB[b], b, BR[b], QR[b], 'R21 PRIVATE COMMENT ' + i]);
  }
  await owner.query("INSERT INTO public.surveys(id,owner_type,name) VALUES($1,'platform','R21 platform survey')", [PLATFORM_SURVEY]);
  await owner.query('COMMIT');
  const hasCampaignFixture = await (async () => {
    try {
      await owner.query('BEGIN');
      const cols = (await owner.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='survey_versions' AND is_nullable='NO' AND column_default IS NULL AND column_name<>'survey_id' ORDER BY ordinal_position")).rows;
      const vals = cols.map(c => c.data_type === 'integer' ? 1 : c.data_type === 'jsonb' || c.data_type === 'json' ? '{}' : c.data_type === 'uuid' ? PLATFORM_SV : c.data_type.startsWith('timestamp') ? new Date().toISOString() : c.data_type === 'boolean' ? false : 'r21');
      await owner.query(`INSERT INTO public.survey_versions(id,survey_id${cols.map(c => ',"' + c.column_name + '"').join('')}) VALUES($1,$2${cols.map((_, i) => ',$' + (i + 3)).join('')})`, [PLATFORM_SV, PLATFORM_SURVEY, ...vals]);
      await owner.query("INSERT INTO public.survey_campaigns(id,survey_id,survey_version_id,name,audience_class) VALUES($1,$2,$3,'R21 platform campaign','customer')", [PLATFORM_CAMPAIGN, PLATFORM_SURVEY, PLATFORM_SV]);
      await owner.query('COMMIT'); return true;
    } catch { await owner.query('ROLLBACK').catch(() => {}); return false; }
  })();

  // ---- 1. clean data: nothing mismatches; the spec covers the catalog; the untenanted platform rows are reported but are NOT violations ----
  const clean = await runPrecheck(owner, { label: 'disposable' });
  check(clean.specificationCoversCatalog && clean.checkedForeignKeys === SPEC.length && clean.coveredByExistingComposite === 4, 'COVERAGE_CLEAN');
  check(clean.verdict === 'NO_TENANT_MISMATCH_FOUND' && clean.totals.tenantMismatch === 0, 'CLEAN_VERDICT');
  check(entry(clean, 'feedback', 'branches', 'branch_id').referencingRows === 2 && entry(clean, 'feedback', 'qr_codes', 'qr_code_id').referencingRows === 2, 'CLEAN_COUNTS');
  if (hasCampaignFixture) { const e = entry(clean, 'survey_campaigns', 'surveys', 'survey_id'); check(e.referencingRows === 1 && e.childUntenanted === 1 && e.parentUntenanted === 1 && e.tenantMismatch === 0, 'UNTENANTED_NOT_A_MISMATCH'); }
  check(clean.countsOnly === true && !JSON.stringify(clean).includes('PRIVATE') && !JSON.stringify(clean).includes('sampleChildIds'), 'COUNTS_ONLY');

  // ---- 2. inject exactly four cross-tenant references (owner, synthetic); the pre-check must count exactly them ----
  await owner.query('INSERT INTO public.feedback(id,business_id,branch_id,qr_code_id,rating,comment) VALUES($1,$2,$3,$4,4,$5)', [BAD_FB1, A, BR[B], QR[A], 'R21 PRIVATE bad branch']);
  await owner.query('INSERT INTO public.feedback(id,business_id,branch_id,qr_code_id,rating,comment) VALUES($1,$2,$3,$4,4,$5)', [BAD_FB2, A, BR[A], QR[B], 'R21 PRIVATE bad qr']);
  await owner.query("INSERT INTO public.critical_incidents(id,business_id,branch_id,feedback_id,matched_signals) VALUES($1,$2,$3,$4,'x')", [BAD_INC, A, BR[B], FB[A]]);
  await owner.query("INSERT INTO public.loyalty_rewards(id,business_id,branch_id,name) VALUES($1,$2,$3,'r21 reward')", [BAD_REWARD, A, BR[B]]);
  const dirty = await runPrecheck(owner, { label: 'disposable' });
  check(dirty.verdict === 'VIOLATIONS_FOUND' && dirty.totals.tenantMismatch === 4, 'DIRTY_TOTAL');
  check(entry(dirty, 'feedback', 'branches', 'branch_id').tenantMismatch === 1 && entry(dirty, 'feedback', 'qr_codes', 'qr_code_id').tenantMismatch === 1 && entry(dirty, 'critical_incidents', 'branches', 'branch_id').tenantMismatch === 1 && entry(dirty, 'loyalty_rewards', 'branches', 'branch_id').tenantMismatch === 1, 'DIRTY_PER_FK');
  check(entry(dirty, 'critical_incidents', 'feedback', 'feedback_id').tenantMismatch === 0, 'DIRTY_NO_FALSE_POSITIVE');
  check(dirty.mismatching.length === 4 && !JSON.stringify(dirty).includes('PRIVATE'), 'DIRTY_LIST_AND_PRIVACY');
  const sampled = await runPrecheck(owner, { label: 'disposable', sample: 5 });
  check(JSON.stringify(entry(sampled, 'feedback', 'branches', 'branch_id').sampleChildIds) === JSON.stringify([BAD_FB1]) && sampled.countsOnly === false && !JSON.stringify(sampled).includes('PRIVATE'), 'SAMPLE_IDS_ONLY');
  for (const bad of [{ label: undefined }, { label: 'prod' }, { label: 'disposable', sample: 21 }, { label: 'disposable', sample: -1 }, { label: 'disposable', sample: 1.5 }]) {
    let refused = false; try { await runPrecheck(owner, bad); } catch { refused = true; } check(refused, 'ARGUMENT_REFUSED');
  }

  // ---- 3. read-only: every statement is a read, the transaction is read-only, a write inside one fails, and a SELECT-only login gets the same answer ----
  const seen = []; const spy = { query: (t, p) => { seen.push(typeof t === 'string' ? t : t.text); return owner.query(t, p); } };
  await runPrecheck(spy, { label: 'disposable' });
  check(seen.length > 5 && seen.every(t => /^\s*(BEGIN READ ONLY|SET LOCAL|SHOW|SELECT|WITH|ROLLBACK)\b/i.test(t)), 'ONLY_READ_STATEMENTS');
  check(seen[0] === 'BEGIN READ ONLY' && seen.at(-1) === 'ROLLBACK', 'READ_ONLY_TRANSACTION_BOUNDS');
  await owner.query('BEGIN READ ONLY'); const w = await attempt(owner, `INSERT INTO public.loyalty_rewards(business_id,name) VALUES ('${A}','x')`); await owner.query('ROLLBACK');
  check(!w.ok && w.code === '25006', 'READ_ONLY_TRANSACTION_REFUSES_WRITES');
  const rows = async () => JSON.stringify((await owner.query("SELECT (SELECT count(*) FROM public.feedback) f,(SELECT count(*) FROM public.critical_incidents) c,(SELECT count(*) FROM public.loyalty_rewards) r,(SELECT count(*) FROM public.branches) b")).rows);
  const before = await rows(); await runPrecheck(owner, { label: 'disposable' }); check(before === await rows(), 'NO_ROWS_CHANGED');
  check((await owner.query("SELECT count(*)::int n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='gate2_r21_readonly_precheck' AND l.granted")).rows[0].n === 0, 'NO_LOCKS_LEFT');
  await owner.query(`CREATE ROLE r21_ro LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'r21_ro'`); await owner.query('GRANT USAGE ON SCHEMA public TO r21_ro'); await owner.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO r21_ro');
  const viaRo = await asLogin('r21_ro', 'r21_ro', c => runPrecheck(c, { label: 'disposable' }));
  check(JSON.stringify(viaRo.entries) === JSON.stringify(dirty.entries) && viaRo.verdict === 'VIOLATIONS_FOUND', 'SELECT_ONLY_LOGIN_SUFFICES');
  const cli = (env, args) => spawnSync(process.execPath, [fileURLToPath(new URL('./gate2-tenant-reference-precheck.mjs', import.meta.url)), ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
  check(cli({}, ['--label', 'disposable']).status === 1, 'CLI_EXIT_VIOLATIONS');
  check(!cli({}, ['--label', 'disposable']).stdout.includes('postgresql://') && !cli({}, ['--label', 'disposable']).stderr.includes('echogrid:echogrid'), 'CLI_NO_CREDENTIALS_PRINTED');
  check(cli({}, []).status === 3 && cli({ DATABASE_URL: '' }, ['--label', 'disposable']).status === 3, 'CLI_EXIT_SAFETY');

  // ---- 4. the proposed pattern, proven on the injected rows: unique parent key, NOT VALID, pre-check == VALIDATE failure, remediate, VALIDATE, enforcement ----
  await owner.query('ALTER TABLE public.branches ADD CONSTRAINT branches_business_id_id_key UNIQUE (business_id, id)');
  await owner.query('ALTER TABLE public.qr_codes ADD CONSTRAINT qr_codes_business_id_id_key UNIQUE (business_id, id)');
  await owner.query('ALTER TABLE public.feedback ADD CONSTRAINT feedback_branch_tenant_fk FOREIGN KEY (business_id, branch_id) REFERENCES public.branches (business_id, id) ON DELETE CASCADE NOT VALID');
  await owner.query('ALTER TABLE public.feedback ADD CONSTRAINT feedback_qr_tenant_fk FOREIGN KEY (business_id, qr_code_id) REFERENCES public.qr_codes (business_id, id) ON DELETE CASCADE NOT VALID');
  const newBad = await attempt(owner, 'INSERT INTO public.feedback(business_id,branch_id,qr_code_id,rating,comment) VALUES($1,$2,$3,5,$4)', [A, BR[B], QR[A], 'r21 new bad']);
  check(!newBad.ok && newBad.code === '23503', 'NOT_VALID_CHECKS_NEW_ROWS');
  const v1 = await attempt(owner, 'ALTER TABLE public.feedback VALIDATE CONSTRAINT feedback_branch_tenant_fk');
  check(!v1.ok && v1.code === '23503', 'VALIDATE_FAILS_ON_EXISTING_VIOLATION'); // the pre-check count for this FK is exactly the rows that block validation
  check(entry(dirty, 'feedback', 'branches', 'branch_id').tenantMismatch >= 1, 'PRECHECK_PREDICTS_VALIDATE_FAILURE');
  await owner.query('UPDATE public.feedback SET branch_id=$1 WHERE id=$2', [BR[A], BAD_FB1]); await owner.query('UPDATE public.feedback SET qr_code_id=$1 WHERE id=$2', [QR[A], BAD_FB2]);   // owner-side remediation (a business decision in reality)
  const after = await runPrecheck(owner, { label: 'disposable' });
  check(entry(after, 'feedback', 'branches', 'branch_id').tenantMismatch === 0 && entry(after, 'feedback', 'qr_codes', 'qr_code_id').tenantMismatch === 0, 'PRECHECK_CLEAN_AFTER_REMEDIATION');
  check((await attempt(owner, 'ALTER TABLE public.feedback VALIDATE CONSTRAINT feedback_branch_tenant_fk')).ok && (await attempt(owner, 'ALTER TABLE public.feedback VALIDATE CONSTRAINT feedback_qr_tenant_fk')).ok, 'VALIDATE_PASSES_WHEN_CLEAN');
  await owner.query('ALTER TABLE public.feedback DROP CONSTRAINT feedback_branch_id_branches_id_fk'); await owner.query('ALTER TABLE public.feedback DROP CONSTRAINT feedback_qr_code_id_qr_codes_id_fk');
  const enforced = await attempt(owner, 'INSERT INTO public.feedback(business_id,branch_id,qr_code_id,rating,comment) VALUES($1,$2,$3,5,$4)', [A, BR[B], QR[A], 'r21 enforced']);
  check(!enforced.ok && enforced.code === '23503', 'COMPOSITE_FK_ENFORCES');
  const own = await attempt(owner, 'INSERT INTO public.feedback(business_id,branch_id,qr_code_id,rating,comment) VALUES($1,$2,$3,5,$4)', [A, BR[A], QR[A], 'r21 own ok']); check(own.ok, 'OWN_TENANT_ALLOWED');
  const casc = await attempt(owner, 'DELETE FROM public.branches WHERE id=$1', [BR[B]]); check(casc.ok, 'DELETE_PARENT_CASCADES');
  check((await owner.query('SELECT count(*)::int n FROM public.feedback WHERE branch_id=$1', [BR[B]])).rows[0].n === 0, 'CASCADE_REMOVED_CHILDREN');
  // column-list SET NULL (PostgreSQL 15+): only the optional reference is cleared; business_id is kept
  await owner.query('CREATE TABLE public.r21_parent(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES public.businesses(id), UNIQUE (business_id, id))');
  await owner.query('CREATE TABLE public.r21_child(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES public.businesses(id), parent_id uuid, FOREIGN KEY (business_id, parent_id) REFERENCES public.r21_parent (business_id, id) ON DELETE SET NULL (parent_id))');
  const par = (await owner.query('INSERT INTO public.r21_parent(business_id) VALUES($1) RETURNING id', [A])).rows[0].id;
  const chi = (await owner.query('INSERT INTO public.r21_child(business_id,parent_id) VALUES($1,$2) RETURNING id', [A, par])).rows[0].id;
  check((await attempt(owner, 'INSERT INTO public.r21_child(business_id,parent_id) VALUES($1,NULL)', [A])).ok, 'MATCH_SIMPLE_NULL_FK_ALLOWED'); // an optional reference left empty is not checked
  check(!(await attempt(owner, 'INSERT INTO public.r21_child(business_id,parent_id) VALUES($1,$2)', [B, par])).ok, 'SET_NULL_VARIANT_STILL_TENANT_SAFE');
  await owner.query('DELETE FROM public.r21_parent WHERE id=$1', [par]);
  const kept = (await owner.query('SELECT business_id::text b, parent_id FROM public.r21_child WHERE id=$1', [chi])).rows[0]; check(kept.b === A && kept.parent_id === null, 'COLUMN_LIST_SET_NULL_KEEPS_TENANT');
  const plainSetNull = await attempt(owner, 'CREATE TABLE public.r21_child2(id uuid PRIMARY KEY, business_id uuid NOT NULL, parent_id uuid, FOREIGN KEY (business_id, parent_id) REFERENCES public.r21_parent (business_id, id) ON DELETE SET NULL)');
  const par2 = (await owner.query('INSERT INTO public.r21_parent(business_id) VALUES($1) RETURNING id', [A])).rows[0].id;
  await owner.query('INSERT INTO public.r21_child2(id,business_id,parent_id) VALUES(gen_random_uuid(),$1,$2)', [A, par2]);
  const plainDel = await attempt(owner, 'DELETE FROM public.r21_parent WHERE id=$1', [par2]);
  check(plainSetNull.ok && !plainDel.ok && plainDel.code === '23502', 'PLAIN_SET_NULL_WOULD_BREAK_NOT_NULL_TENANT_COLUMN'); // why the column list is required

  // ---- 5. specification drift fails closed ----
  await owner.query('DROP TABLE public.r21_child2'); await owner.query('DROP TABLE public.r21_child'); await owner.query('DROP TABLE public.r21_parent');
  await owner.query('CREATE TABLE public.r21_extra(id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES public.businesses(id), branch_id uuid REFERENCES public.branches(id))');
  const d1 = await runPrecheck(owner, { label: 'disposable' }); check(d1.verdict === 'SPECIFICATION_DRIFT' && d1.coverage.unclassified.includes('r21_extra|branches|branch_id'), 'DRIFT_UNCLASSIFIED');
  check(cli({}, ['--label', 'disposable']).status === 2, 'CLI_EXIT_DRIFT');
  await owner.query('DROP TABLE public.r21_extra');
  const fkName = (await owner.query("SELECT conname FROM pg_constraint WHERE conrelid='public.loyalty_rewards'::regclass AND contype='f' AND confrelid='public.branches'::regclass")).rows[0].conname;
  await owner.query(`ALTER TABLE public.loyalty_rewards DROP CONSTRAINT "${fkName}"`);
  const d2 = await runPrecheck(owner, { label: 'disposable' }); check(d2.verdict === 'SPECIFICATION_DRIFT' && d2.coverage.stale.includes('loyalty_rewards|branches|branch_id'), 'DRIFT_STALE');

  // a column that becomes nullable invalidates a STRAIGHT classification: the pre-check refuses to call it clean
  await owner.query('ALTER TABLE public.feedback_summaries ALTER COLUMN business_id DROP NOT NULL');
  const d3 = await runPrecheck(owner, { label: 'disposable' }); check(d3.verdict === 'SPECIFICATION_DRIFT' && d3.coverage.inconsistent.includes('feedback_summaries|branches|branch_id'), 'DRIFT_INCONSISTENT');

  console.log(JSON.stringify({
    gate: 'GATE2_R21_PRECHECK_AND_COMPOSITE_PATTERN', checks, specEntries: SPEC.length, coveredByExistingComposite: 4,
    precheckCountsExactInjectedViolations: true, precheckReadOnly: true, countsOnlyByDefault: true, selectOnlyLoginSufficient: true, driftFailsClosed: true,
    compositePattern: { notValidChecksNewRows: true, validateFailsOnExistingViolationsPredictedByPrecheck: true, validatePassesWhenClean: true, matchSimpleNullFkAllowed: true, columnListSetNullKeepsTenant: true, plainSetNullBreaksNotNullTenantColumn: true },
    nullableTenantRowsNotMismatches: hasCampaignFixture ? 'VERIFIED' : 'FIXTURE_NOT_BUILT',
    noLiveNeonWrites: true, migrationAdded: false, financialAuthorization: 'NOT_GRANTED',
  }));
} finally { await owner.end().catch(() => {}); }
