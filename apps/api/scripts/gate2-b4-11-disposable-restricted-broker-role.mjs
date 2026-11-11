/**
 * Gate 2 B4-11 — restricted nonowner broker database role with ONE fixed, use-time-authorized operation (branch read).
 *
 * Disposable CI only, on the REAL schema (68 migrations replayed). No Drizzle migration, no Neon/Hyperdrive/Cloudflare resource, no deployment. The broker service itself (which verifies the B4-03/B4-09 signed
 * evidence before connecting as this login) does not exist yet; this proves what the DATABASE side must enforce on its own. See docs/architecture/builds/SPLIT-08/GATE2_B4_11_RESTRICTED_BROKER_DATABASE_ROLE.md.
 */
import pg from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const DB_URL = 'postgresql://echogrid:echogrid@localhost:5432/echogrid_ci_pg18_b411';
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GATE2_B411_DISPOSABLE !== 'I_ACKNOWLEDGE_DISPOSABLE_PG18' || process.env.DATABASE_URL !== DB_URL) throw Error('GATE2_B411_NON_DISPOSABLE_TARGET_DENIED');

const BROKER = { name: 'gate2_b411_broker', password: 'gate2_b411_' + randomBytes(6).toString('hex') };
const OTHER = { name: 'gate2_b411_other', password: 'gate2_b411_' + randomBytes(6).toString('hex') };
let checks = 0;
const check = (ok, code) => { checks++; if (!ok) throw Error('GATE2_B411_' + code); };
const owner = new pg.Client({ connectionString: DB_URL });
const sleep = ms => delay(ms);
const login = async (who, app = 'gate2_b411_client') => { const u = new URL(DB_URL); u.username = who.name; u.password = who.password; const c = new pg.Client({ connectionString: u.toString(), application_name: app }); await c.connect(); return c; };
const attempt = async (c, text, params = []) => { try { const r = await c.query(text, params); return { ok: true, rows: r.rows, rowCount: r.rowCount }; } catch (e) { return { ok: false, code: e.code, message: String(e.message) }; } };
const CALL = 'SELECT * FROM gate2_b411.branch_read($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint)';
const args = (o, over = {}) => { const a = { nonce: randomUUID(), exp: Date.now() + 30000, ...o, ...over }; return [a.actor, a.sid, a.business, a.branch, a.nonce, a.exp]; };
const call = async (c, o, over) => { const r = await attempt(c, CALL, args(o, over)); return r.ok ? { ...r, outcome: r.rows[0].outcome, row: r.rows[0] } : r; };
const q = async (text, params = []) => (await owner.query(text, params)).rows;
const nonceCount = async nonce => (await q('SELECT count(*)::int n FROM gate2_b411.nonces WHERE nonce=$1', [nonce]))[0].n;
const waitingBackend = async app => { for (let i = 0; i < 40; i++) { const r = await q("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND state='active'", [app]); if (r.length) return true; await sleep(50); } return false; };

const uid = (k, n) => `${k}9100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = uid('a', 1), B = uid('a', 2), A1 = uid('b', 1), A2 = uid('b', 2), B1 = uid('b', 3);
const mkUser = async (n, over = {}) => { const id = uid('c', n); await q("INSERT INTO public.users(id,email,password_hash,full_name,status,is_deleted,deleted_at) VALUES($1,$2,'x','B411 synthetic',$3,$4,$5)", [id, `b411-${n}@example.test`, over.status ?? 'active', over.isDeleted ?? false, over.deletedAt ?? null]); return id; };
const mkSession = async (user, over = {}) => { const sid = randomUUID(); await q("INSERT INTO public.refresh_tokens(id,user_id,token_hash,session_id,expires_at,revoked_at) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), user, randomUUID(), sid, over.expires ?? new Date(Date.now() + 3_600_000), over.revoked ?? null]); return sid; };

try {
  await owner.connect();
  const info = (await q("SELECT current_database() db,current_user usr,current_setting('server_version_num')::int v"))[0];
  check(info.db === 'echogrid_ci_pg18_b411' && info.usr === 'echogrid' && Math.floor(info.v / 10000) === 18, 'DATABASE_IDENTITY');
  check((await q('SELECT count(*)::int n FROM drizzle.__drizzle_migrations'))[0].n === 68, 'MIGRATION_COUNT');

  // ---- fixtures on the real tables (synthetic) ----
  await q("INSERT INTO public.permissions(key,description,category) VALUES ('branches:view','b411','b411'),('feedback:view','b411','b411') ON CONFLICT (key) DO NOTHING");
  const perm = async k => (await q('SELECT id FROM public.permissions WHERE key=$1', [k]))[0].id;
  await q("INSERT INTO public.businesses(id,name,slug) VALUES($1,'B411 A','b411-a'),($2,'B411 B','b411-b')", [A, B]);
  await q("INSERT INTO public.branches(id,business_id,name,slug) VALUES($1,$2,'B411 Alpha One','a1'),($3,$2,'B411 Alpha Two','a2'),($4,$5,'B411 Beta One','b1')", [A1, A, A2, B1, B]);
  const role = async (n, biz, key) => { const id = uid('d', n); await q("INSERT INTO public.roles(id,business_id,name) VALUES($1,$2,$3)", [id, biz, 'b411-role-' + n]); await q('INSERT INTO public.role_permissions(role_id,permission_id) VALUES($1,$2)', [id, await perm(key)]); return id; };
  const roleAView = await role(1, A, 'branches:view'), roleANone = await role(2, A, 'feedback:view'), roleBView = await role(3, B, 'branches:view');
  const grant = async (user, biz, r, branch = null) => (await q('INSERT INTO public.user_business_roles(user_id,business_id,role_id,branch_id) VALUES($1,$2,$3,$4) RETURNING id', [user, biz, r, branch]))[0].id;
  const U = { wide: await mkUser(1), scoped: await mkUser(2), noperm: await mkUser(3), b: await mkUser(4), stranger: await mkUser(5), deleted: await mkUser(6, { isDeleted: true, deletedAt: new Date() }), suspended: await mkUser(7, { status: 'suspended' }),
    cross: await mkUser(8), scopedForeign: await mkUser(9), race: await mkUser(10), race2: await mkUser(11), race3: await mkUser(12) };
  await grant(U.wide, A, roleAView); await grant(U.scoped, A, roleAView, A1); await grant(U.noperm, A, roleANone); await grant(U.b, B, roleBView);
  await grant(U.deleted, A, roleAView); await grant(U.suspended, A, roleAView);
  await grant(U.cross, A, roleBView);              // INJECTED: a grant in business A that points at business B's role (single-column FKs allow it; the R20 finding)
  await grant(U.scopedForeign, A, roleAView, B1);  // INJECTED: a business-A grant scoped to business B's branch
  await grant(U.race, A, roleAView); await grant(U.race2, A, roleAView); const raceGrant = await grant(U.race3, A, roleAView);
  const S = {}; for (const [k, u] of Object.entries(U)) S[k] = await mkSession(u);
  const sessWithRows = { expired: await mkSession(U.wide, { expires: new Date(Date.now() - 1000) }), revoked: await mkSession(U.wide, { revoked: new Date() }) };
  const req = (who, business = A, branch = A1, sid = S[who]) => ({ actor: U[who], sid, business, branch });

  // ---- the restricted objects (owner-only SQL file) and two logins ----
  await owner.query(readFileSync(fileURLToPath(new URL('./sql/gate2-b4-11-restricted-broker-role.sql', import.meta.url)), 'utf8'));
  for (const who of [BROKER, OTHER]) await q(`CREATE ROLE "${who.name}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD '${who.password}'`);
  await q(`GRANT USAGE ON SCHEMA gate2_b411 TO "${BROKER.name}"`);
  await q(`GRANT EXECUTE ON FUNCTION gate2_b411.branch_read(uuid, uuid, uuid, uuid, uuid, bigint) TO "${BROKER.name}"`);
  await q(`ALTER ROLE "${BROKER.name}" SET statement_timeout = '10s'`); await q(`ALTER ROLE "${BROKER.name}" SET idle_in_transaction_session_timeout = '15s'`);
  await q(`GRANT USAGE ON SCHEMA gate2_b411 TO "${OTHER.name}"`);
  const broker = await login(BROKER);

  // ---- 1. the login holds nothing: no table, view, sequence or schema privilege anywhere ----
  const held = await q(`SELECT c.oid::regclass::text rel, p.priv FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(priv)
    WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND c.relkind IN ('r','p','v','m','f') AND (has_table_privilege($1, c.oid, p.priv) OR CASE WHEN p.priv IN ('SELECT','INSERT','UPDATE','REFERENCES') THEN has_any_column_privilege($1, c.oid, p.priv) ELSE false END)`, [BROKER.name]);
  check(held.length === 0, 'BROKER_HOLDS_TABLE_PRIVILEGES_' + JSON.stringify(held.slice(0, 3)));
  check((await q(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname NOT IN ('pg_catalog','information_schema') AND (has_sequence_privilege($1,c.oid,'USAGE') OR has_sequence_privilege($1,c.oid,'SELECT') OR has_sequence_privilege($1,c.oid,'UPDATE'))`, [BROKER.name]))[0].n === 0, 'BROKER_HOLDS_SEQUENCE_PRIVILEGES');
  check((await q(`SELECT count(*)::int n FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' AND has_schema_privilege($1, oid, 'CREATE')`, [BROKER.name]))[0].n === 0, 'BROKER_SCHEMA_CREATE');
  check(JSON.stringify((await q(`SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname NOT IN ('information_schema','public') AND has_schema_privilege($1, oid, 'USAGE') ORDER BY 1`, [BROKER.name])).map(r => r.nspname)) === JSON.stringify(['gate2_b411']), 'BROKER_SCHEMA_USAGE');
  const callable = await q(`SELECT n.nspname||'.'||p.proname AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prorettype <> 'trigger'::regtype AND p.prokind='f'
    AND has_function_privilege($1, p.oid, 'EXECUTE') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e') ORDER BY 1`, [BROKER.name]);
  // FINDING: two existing application functions carry the default PUBLIC EXECUTE, so every login (the broker included) can call them. Both run with invoker rights and touch no table: a pure digest, and an advisory-lock
  // acquirer (a lock-holding nuisance bounded by the transaction and the role's idle timeout). The set is pinned: anything new that becomes callable fails this check and must be reviewed.
  const KNOWN_PUBLIC_EXECUTE = ['public.partner_credit_settlement_auth_digest', 'public.pc_multiunit_month_lock'];
  const extra = callable.map(r => r.fn).filter(f => f !== 'gate2_b411.branch_read');
  check(JSON.stringify(extra) === JSON.stringify(KNOWN_PUBLIC_EXECUTE), 'BROKER_CALLABLE_FUNCTIONS_' + JSON.stringify(extra.slice(0, 8)));
  const knownMeta = await q("SELECT p.proname, p.prosecdef, p.prosrc ~* '(from|join|into|update|delete)\\s+(public\\.)?[a-z_]+\\s' AS reads FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname = ANY($1)", [['partner_credit_settlement_auth_digest', 'pc_multiunit_month_lock']]);
  check(knownMeta.length === 2 && knownMeta.every(r => r.prosecdef === false), 'KNOWN_PUBLIC_FUNCTIONS_ARE_INVOKER_RIGHTS');
  const attr = (await q('SELECT rolcanlogin,rolbypassrls,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolinherit FROM pg_roles WHERE rolname=$1', [BROKER.name]))[0];
  check(attr.rolcanlogin && !attr.rolbypassrls && !attr.rolsuper && !attr.rolcreaterole && !attr.rolcreatedb && !attr.rolreplication && !attr.rolinherit, 'BROKER_ROLE_ATTRIBUTES');
  check((await q('SELECT count(*)::int n FROM pg_auth_members WHERE member=$1::regrole', [BROKER.name]))[0].n === 0, 'BROKER_HAS_NO_ROLE_MEMBERSHIPS');
  const rs = (await q('SELECT setconfig FROM pg_db_role_setting WHERE setrole=$1::regrole', [BROKER.name]))[0]?.setconfig ?? [];
  check(rs.includes('statement_timeout=10s') && rs.includes('idle_in_transaction_session_timeout=15s'), 'BROKER_ROLE_TIMEOUTS');
  // the routine owner holds no more than SELECT and ONE column UPDATE per locked table, and nothing on any other application table
  const ownerPriv = await q(`SELECT c.relname, p.priv, has_table_privilege('gate2_b411_owner', c.oid, p.priv) AS t, CASE WHEN p.priv IN ('SELECT','INSERT','UPDATE','REFERENCES') THEN has_any_column_privilege('gate2_b411_owner', c.oid, p.priv) ELSE false END AS c FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(priv) WHERE n.nspname='public' AND c.relkind IN ('r','p')`);
  const locked = ['users', 'businesses', 'branches', 'roles', 'refresh_tokens', 'user_business_roles', 'role_permissions', 'permissions'];
  check(ownerPriv.every(r => r.t === false || (r.priv === 'SELECT' && locked.includes(r.relname))), 'OWNER_NO_TABLE_WIDE_WRITE_PRIVILEGE'); // table-wide SELECT on the locked tables only; writes are one column each
  check(ownerPriv.filter(r => r.c).every(r => locked.includes(r.relname) && ['SELECT', 'UPDATE'].includes(r.priv)), 'OWNER_ONLY_SELECT_AND_COLUMN_UPDATE_ON_LOCKED_TABLES');
  check(locked.every(t => ownerPriv.some(r => r.relname === t && r.priv === 'UPDATE' && r.c)), 'OWNER_HAS_LOCK_PRIVILEGE');
  const fn = (await q("SELECT p.prosecdef, pg_get_userbyid(p.proowner) o, p.proconfig, has_function_privilege('public', p.oid, 'EXECUTE') pub, p.prosrc FROM pg_proc p WHERE p.proname='branch_read' AND p.pronamespace='gate2_b411'::regnamespace"))[0];
  check(fn.prosecdef && fn.o === 'gate2_b411_owner' && !fn.pub && fn.proconfig.includes('search_path=pg_catalog') && fn.proconfig.includes('lock_timeout=3s'), 'ROUTINE_DEFINITION');
  const mentioned = [...new Set([...fn.prosrc.matchAll(/(?:FROM|JOIN|INTO)\s+(?:public|gate2_b411)\.([a-z_]+)/gi)].map(m => m[1]))].sort();
  check(JSON.stringify(mentioned) === JSON.stringify([...locked, 'nonces'].sort()), 'ROUTINE_TOUCHES_ONLY_ALLOWED_TABLES_' + mentioned.join(','));
  check(!/stripe|partner_credit|settlement|ledger|approval_enabled|evidence/i.test(fn.prosrc), 'ROUTINE_NO_FINANCIAL_REFERENCE');

  // ---- 2. arbitrary SQL, direct CRUD and escalation are denied ----
  for (const t of ['users', 'branches', 'businesses', 'feedback', 'user_business_roles', 'refresh_tokens', 'partner_credit_ledger', 'stripe_read_authorization_policy', 'signed_evidence_records']) check((await attempt(broker, `SELECT * FROM public.${t}`)).code === '42501', 'DIRECT_SELECT_' + t);
  check((await attempt(broker, 'SELECT * FROM gate2_b411.nonces')).code === '42501', 'NONCE_TABLE_DIRECT_READ');
  check((await attempt(broker, `INSERT INTO gate2_b411.nonces(nonce,actor,session_id,business,branch,expires_at) VALUES (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),now())`)).code === '42501', 'NONCE_FORGERY');
  for (const text of ["UPDATE public.branches SET name='x'", 'DELETE FROM public.branches', 'TRUNCATE public.branches', "INSERT INTO public.branches(business_id,name,slug) VALUES (gen_random_uuid(),'x','x')", 'CREATE TABLE public.b411_probe(x int)', 'CREATE SCHEMA b411_probe', 'CREATE ROLE b411_probe', `SET ROLE "echogrid"`, `SET ROLE "${OTHER.name}"`, `SET SESSION AUTHORIZATION "echogrid"`, 'COPY public.branches TO STDOUT', "ALTER ROLE gate2_b411_broker SUPERUSER", 'GRANT ALL ON public.branches TO PUBLIC', 'ALTER TABLE public.branches DISABLE ROW LEVEL SECURITY', "CREATE FUNCTION public.b411_f() RETURNS int LANGUAGE sql AS 'select 1'"])
    check(!(await attempt(broker, text)).ok, 'DENIED_' + text.slice(0, 30));
  check((await attempt(broker, "DO $$ BEGIN PERFORM count(*) FROM public.users; END $$")).code === '42501', 'DO_BLOCK_CANNOT_READ');
  check((await attempt(broker, 'SELECT * FROM pg_read_file($1)', ['/etc/passwd'])).code === '42501', 'FILE_READ_DENIED');
  const other = await login(OTHER);
  const asOther = await attempt(other, CALL, args(req('wide'))); check(!asOther.ok && asOther.code === '42501', 'OTHER_LOGIN_CANNOT_EXECUTE');
  // even a login that was (wrongly) granted EXECUTE is refused by the routine itself
  await q(`GRANT EXECUTE ON FUNCTION gate2_b411.branch_read(uuid, uuid, uuid, uuid, uuid, bigint) TO "${OTHER.name}"`);
  const stillOther = await attempt(other, CALL, args(req('wide'))); check(!stillOther.ok && /GATE2_B411_CALLER_NOT_BROKER/.test(stillOther.message), 'ROUTINE_REFUSES_NON_BROKER_LOGIN');
  await q(`REVOKE EXECUTE ON FUNCTION gate2_b411.branch_read(uuid, uuid, uuid, uuid, uuid, bigint) FROM "${OTHER.name}"`);
  await other.end();
  const inj = "x'; DROP TABLE public.users; --";
  check((await attempt(broker, CALL, [inj, S.wide, A, A1, randomUUID(), Date.now() + 30000])).code === '22P02', 'INJECTION_TEXT_REJECTED_BY_TYPE'); // the argument is a uuid, never SQL text
  check((await attempt(broker, 'SELECT * FROM gate2_b411.branch_read($1::text,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint)', [inj, S.wide, A, A1, randomUUID(), Date.now() + 30000])).code === '42883', 'NO_TEXT_OVERLOAD');
  check((await q('SELECT count(*)::int n FROM public.users'))[0].n >= 11, 'USERS_TABLE_INTACT');

  // ---- 3. the fixed operation: allowed cases return exactly id and name ----
  const ok1 = await call(broker, req('wide'));
  check(ok1.outcome === 'OK' && ok1.row.branch_id === A1 && ok1.row.branch_name === 'B411 Alpha One' && JSON.stringify(Object.keys(ok1.row)) === JSON.stringify(['outcome', 'branch_id', 'branch_name']), 'OK_BUSINESS_WIDE');
  check((await call(broker, req('wide', A, A2))).outcome === 'OK', 'OK_OTHER_BRANCH_SAME_BUSINESS');
  check((await call(broker, req('scoped', A, A1))).outcome === 'OK', 'OK_BRANCH_SCOPED_GRANT');
  check((await call(broker, req('b', B, B1))).outcome === 'OK', 'OK_OTHER_TENANT_OWN');

  // ---- 4. use-time authorization: every missing link denies ----
  const deny = async (o, reason, why, over) => { const r = await call(broker, o, over); check(r.outcome === reason, `DENY_${why}_GOT_${r.outcome ?? r.code}`); return r; };
  await deny(req('scoped', A, A2), 'DENIED_GRANT', 'SCOPED_GRANT_OTHER_BRANCH');
  await deny(req('noperm'), 'DENIED_GRANT', 'ROLE_WITHOUT_PERMISSION');
  await deny(req('b', A, A1), 'DENIED_GRANT', 'FOREIGN_BUSINESS_MEMBER');
  await deny(req('b', B, A1), 'DENIED_BRANCH', 'BRANCH_OF_OTHER_BUSINESS');
  await deny(req('wide', A, B1), 'DENIED_BRANCH', 'FOREIGN_BRANCH_WITH_OWN_BUSINESS');
  await deny(req('stranger'), 'DENIED_GRANT', 'NO_MEMBERSHIP');
  await deny(req('cross'), 'DENIED_GRANT', 'INJECTED_CROSS_TENANT_ROLE');
  await deny(req('scopedForeign', A, A1), 'DENIED_GRANT', 'INJECTED_GRANT_SCOPED_TO_FOREIGN_BRANCH');
  await deny(req('scopedForeign', A, B1), 'DENIED_BRANCH', 'FOREIGN_BRANCH_VIA_INJECTED_GRANT');
  await deny(req('deleted'), 'DENIED_ACTOR', 'DELETED_ACTOR');
  await deny(req('suspended'), 'DENIED_ACTOR', 'SUSPENDED_ACTOR');
  await deny({ actor: uid('c', 999), sid: S.wide, business: A, branch: A1 }, 'DENIED_ACTOR', 'UNKNOWN_ACTOR');
  await deny(req('wide', A, A1, randomUUID()), 'DENIED_SESSION', 'UNKNOWN_SESSION');
  await deny(req('wide', A, A1, S.b), 'DENIED_SESSION', 'SESSION_OF_ANOTHER_ACTOR');
  await deny(req('wide', A, A1, sessWithRows.expired), 'DENIED_SESSION', 'EXPIRED_SESSION');
  await deny(req('wide', A, A1, sessWithRows.revoked), 'DENIED_SESSION', 'REVOKED_SESSION');
  await q("UPDATE public.businesses SET status='suspended' WHERE id=$1", [B]); await deny(req('b', B, B1), 'DENIED_BUSINESS', 'SUSPENDED_BUSINESS'); await q("UPDATE public.businesses SET status='active' WHERE id=$1", [B]);
  await q("UPDATE public.branches SET is_deleted=true WHERE id=$1", [A2]); await deny(req('wide', A, A2), 'DENIED_BRANCH', 'DELETED_BRANCH'); await q("UPDATE public.branches SET is_deleted=false WHERE id=$1", [A2]);
  await q("UPDATE public.roles SET is_deleted=true WHERE id=$1", [roleAView]); await deny(req('wide'), 'DENIED_GRANT', 'DELETED_ROLE'); await q("UPDATE public.roles SET is_deleted=false WHERE id=$1", [roleAView]);
  await q("DELETE FROM public.role_permissions WHERE role_id=$1", [roleAView]); await deny(req('wide'), 'DENIED_GRANT', 'PERMISSION_REMOVED'); await q('INSERT INTO public.role_permissions(role_id,permission_id) VALUES($1,$2)', [roleAView, await perm('branches:view')]);
  check((await call(broker, req('wide'))).outcome === 'OK', 'RESTORED_STATE_AUTHORIZES_AGAIN'); // nothing was cached

  // ---- 5. single use, bounded window, malformed input ----
  const n1 = randomUUID(); check((await call(broker, req('wide'), { nonce: n1 })).outcome === 'OK' && (await call(broker, req('wide'), { nonce: n1 })).outcome === 'REPLAYED', 'REPLAY_AFTER_OK');
  const n2 = randomUUID(); check((await call(broker, req('stranger'), { nonce: n2 })).outcome === 'DENIED_GRANT' && (await call(broker, req('wide'), { nonce: n2 })).outcome === 'REPLAYED', 'REPLAY_AFTER_DENIAL_CONSUMES');
  const n3 = randomUUID(); const exp = await call(broker, req('wide'), { nonce: n3, exp: Date.now() - 1000 });
  check(!exp.ok && /GATE2_B411_EXPIRED/.test(exp.message) && await nonceCount(n3) === 0, 'EXPIRED_REFUSED_UNCONSUMED');
  const n4 = randomUUID(); const wide = await call(broker, req('wide'), { nonce: n4, exp: Date.now() + 600000 });
  check(!wide.ok && /GATE2_B411_WINDOW/.test(wide.message) && await nonceCount(n4) === 0, 'WINDOW_REFUSED_UNCONSUMED');
  for (const k of ['actor', 'sid', 'business', 'branch', 'nonce', 'exp']) { const a = args(req('wide')); a[['actor', 'sid', 'business', 'branch', 'nonce', 'exp'].indexOf(k)] = null; const r = await attempt(broker, CALL, a); check(!r.ok && /GATE2_B411_MALFORMED/.test(r.message), 'NULL_' + k); }
  check((await attempt(broker, CALL, ['nope', S.wide, A, A1, randomUUID(), Date.now() + 30000])).code === '22P02', 'BAD_UUID_REFUSED');
  const stale = randomUUID(); await q("INSERT INTO gate2_b411.nonces(nonce,actor,session_id,business,branch,expires_at) VALUES($1,$2,$3,$4,$5,now() - interval '1 hour')", [stale, U.wide, S.wide, A, A1]);
  await call(broker, req('wide')); check(await nonceCount(stale) === 0, 'EXPIRED_NONCES_REMOVED_BY_ROUTINE');
  const recent = randomUUID(); await q("INSERT INTO gate2_b411.nonces(nonce,actor,session_id,business,branch,expires_at) VALUES($1,$2,$3,$4,$5,now() - interval '1 minute')", [recent, U.wide, S.wide, A, A1]);
  await call(broker, req('wide')); check(await nonceCount(recent) === 1, 'RECENT_NONCES_KEPT');

  // ---- 6. session state cannot be steered from the connection: search_path, shadow objects, settings, pooling ----
  await broker.query("SET search_path = pg_temp, public");
  await broker.query('CREATE TEMP TABLE users(id uuid, status text, is_deleted boolean, deleted_at timestamptz)');
  await broker.query("INSERT INTO pg_temp.users VALUES ($1,'active',false,null)", [U.stranger]);
  check((await call(broker, req('stranger'))).outcome === 'DENIED_GRANT' && (await call(broker, req('wide'))).outcome === 'OK', 'SHADOW_TABLE_IGNORED');
  await broker.query('DROP TABLE pg_temp.users; RESET search_path');
  await broker.query("SELECT set_config('echogrid.tenant_id',$1,false)", [B]);
  const gucProbe = await call(broker, { actor: U.wide, sid: S.wide, business: B, branch: B1 }); check(gucProbe.outcome === 'DENIED_GRANT', 'GUC_DOES_NOT_GRANT');
  const before = JSON.stringify(await q("SELECT (SELECT count(*) FROM public.users) u,(SELECT count(*) FROM public.branches) b,(SELECT count(*) FROM public.refresh_tokens) r,(SELECT count(*) FROM public.user_business_roles) g"));
  for (let i = 0; i < 5; i++) await call(broker, req(i % 2 ? 'wide' : 'b', i % 2 ? A : B, i % 2 ? A1 : B1));
  check(before === JSON.stringify(await q("SELECT (SELECT count(*) FROM public.users) u,(SELECT count(*) FROM public.branches) b,(SELECT count(*) FROM public.refresh_tokens) r,(SELECT count(*) FROM public.user_business_roles) g")), 'APPLICATION_ROWS_UNCHANGED');
  await broker.end();

  // ---- 7. concurrency: one nonce, many connections ----
  const pool = await Promise.all(Array.from({ length: 8 }, () => login(BROKER)));
  const shared = randomUUID(); const results = await Promise.all(pool.map(c => call(c, req('wide'), { nonce: shared })));
  check(results.filter(r => r.outcome === 'OK').length === 1 && results.filter(r => r.outcome === 'REPLAYED').length === 7, 'CONCURRENT_SAME_NONCE_ONE_WINNER');
  check(await nonceCount(shared) === 1, 'CONCURRENT_NONCE_SINGLE_ROW');
  const distinct = await Promise.all(pool.map((c, i) => call(c, req(i % 2 ? 'wide' : 'b', i % 2 ? A : B, i % 2 ? A1 : B1))));
  check(distinct.every((r, i) => r.outcome === 'OK' && r.row.branch_id === (i % 2 ? A1 : B1)), 'CONCURRENT_DISTINCT_TENANTS_NO_LEAK');
  await Promise.all(pool.map(c => c.end()));

  // ---- 8. revocation races on the REAL tables (revoke first / issue first), and a lock timeout that consumes nothing ----
  const raceBroker = await login(BROKER, 'gate2_b411_race_broker'); const rev = new pg.Client({ connectionString: DB_URL, application_name: 'gate2_b411_revoker' }); await rev.connect();
  // revoke first: the broker waits on the session row, then sees the revocation
  await rev.query('BEGIN'); await rev.query('UPDATE public.refresh_tokens SET revoked_at = now() WHERE session_id=$1', [S.race]);
  const nRace = randomUUID(); const blocked = call(raceBroker, req('race'), { nonce: nRace });
  check(await waitingBackend('gate2_b411_race_broker'), 'REVOKE_FIRST_BROKER_WAITS'); await rev.query('COMMIT');
  check((await blocked).outcome === 'DENIED_SESSION', 'REVOKE_FIRST_DENIED'); check(await nonceCount(nRace) === 1, 'REVOKE_FIRST_NONCE_CONSUMED');
  // issue first: the in-flight authorization holds its locks; the revoker waits; afterwards the session is dead
  const sidIssue = await mkSession(U.race2); await raceBroker.query('BEGIN'); const first = await call(raceBroker, { actor: U.race2, sid: sidIssue, business: A, branch: A1 });
  check(first.outcome === 'OK', 'ISSUE_FIRST_OK');
  const revoking = rev.query('UPDATE public.refresh_tokens SET revoked_at = now() WHERE session_id=$1', [sidIssue]);
  check(await waitingBackend('gate2_b411_revoker'), 'ISSUE_FIRST_REVOKER_WAITS'); await raceBroker.query('COMMIT'); await revoking;
  check((await call(raceBroker, { actor: U.race2, sid: sidIssue, business: A, branch: A1 })).outcome === 'DENIED_SESSION', 'ISSUE_FIRST_THEN_REVOKED');
  // grant revocation, same two orders
  await rev.query('BEGIN'); await rev.query('UPDATE public.user_business_roles SET deleted_at = now() WHERE id=$1', [raceGrant]);
  const g1 = call(raceBroker, req('race3', A, A2)); check(await waitingBackend('gate2_b411_race_broker'), 'GRANT_REVOKE_FIRST_BROKER_WAITS'); await rev.query('COMMIT');
  check((await g1).outcome === 'DENIED_GRANT', 'GRANT_REVOKE_FIRST_DENIED');
  // lock timeout: nothing is consumed and the retry works once the lock is gone
  await rev.query('BEGIN'); await rev.query('SELECT 1 FROM public.users WHERE id=$1 FOR UPDATE', [U.wide]);
  const nLock = randomUUID(); const t0 = Date.now(); const timedOut = await call(raceBroker, req('wide'), { nonce: nLock });
  check(!timedOut.ok && timedOut.code === '55P03' && Date.now() - t0 >= 2500 && Date.now() - t0 < 6000, 'LOCK_TIMEOUT_BOUNDED'); check(await nonceCount(nLock) === 0, 'LOCK_TIMEOUT_NOT_CONSUMED');
  await rev.query('ROLLBACK'); check((await call(raceBroker, req('wide'), { nonce: nLock })).outcome === 'OK', 'RETRY_AFTER_LOCK_TIMEOUT');
  // forced outage: the backend is killed mid-call; its nonce consumption rolls back with it
  const victim = await login(BROKER, 'gate2_b411_victim'); const nKill = randomUUID();
  await victim.query('BEGIN'); const inflight = await call(victim, req('wide'), { nonce: nKill }); check(inflight.outcome === 'OK', 'OUTAGE_INFLIGHT_OK');
  const pid = (await q("SELECT pid FROM pg_stat_activity WHERE application_name='gate2_b411_victim'"))[0].pid; victim.on('error', () => {});
  await q('SELECT pg_terminate_backend($1)', [pid]); await sleep(200);
  check(await nonceCount(nKill) === 0, 'OUTAGE_NONCE_ROLLED_BACK'); check((await call(raceBroker, req('wide'), { nonce: nKill })).outcome === 'OK', 'OUTAGE_RETRY_NOT_REPLAYED');
  // the routine owner's single-column UPDATE is genuinely required: without it the row-locking SELECT is refused (so the privilege is not decoration, and removing it fails closed)
  await q('REVOKE UPDATE (updated_by) ON public.users FROM gate2_b411_owner');
  const noUpdate = await call(raceBroker, req('wide')); check(!noUpdate.ok && noUpdate.code === '42501', 'ROW_LOCK_NEEDS_UPDATE_PRIVILEGE');
  await q('GRANT UPDATE (updated_by) ON public.users TO gate2_b411_owner'); check((await call(raceBroker, req('wide'))).outcome === 'OK', 'PRIVILEGE_RESTORED');
  await victim.end().catch(() => {}); await rev.end(); await raceBroker.end();

  console.log(JSON.stringify({
    gate: 'GATE2_B4_11_PG18_RESTRICTED_BROKER_ROLE', checks, schema: 'REAL_67_MIGRATIONS', operation: 'branch_read_only', brokerLoginHoldsNoTableSequenceOrSchemaPrivilege: true, routineOwnerSelectAndOneColumnUpdate: true,
    useTimeAuthorization: 'SESSION_ACTOR_BUSINESS_BRANCH_GRANT_TENANT_MATCHED', singleUseNonceEveryOutcome: true, revocationRacesSerialized: true, lockTimeoutAndOutageConsumeNothing: true, arbitrarySqlAndDirectCrudDenied: true,
    injectedCrossTenantGrantsDenied: true, findings: ['PUBLIC_EXECUTE_ON_PARTNER_CREDIT_DIGEST_AND_ADVISORY_LOCK_FUNCTIONS', 'ROW_LOCKING_REQUIRES_COLUMN_UPDATE_PRIVILEGE_FOR_ROUTINE_OWNER'], signatureVerifiedInDatabase: false, brokerServiceExists: false, hyperdriveCompatibility: 'NOT_CERTIFIED', runtimeRoleReady: false, stagingCertification: 'BLOCKED',
    noLiveNeonWrites: true, migrationAdded: false, financialAuthorization: 'NOT_GRANTED',
  }));
} finally { await owner.end().catch(() => {}); }
