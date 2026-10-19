import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * HETA-01-F1 IMPL-1: T44 (catalog equals the machine-readable contract) plus the constraint-level
 * guarantees of migration 0045 (T26/T32/T35/T36/T38/T42/T43 constraint parts) and preservation of
 * the 0040-0044 economic guards (T27). Requires a migrated, disposable DATABASE_URL.
 * Rows written here are append-only by design, so the suite works inside one transaction that is
 * always rolled back; nothing persists.
 */
const contract = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../docs/architecture/builds/SPLIT-07/stripe-evidence-contract.json'), 'utf8'),
) as {
  immutabilityFunction: string;
  tables: Record<string, { columns: string[]; checks: string[]; uniques: string[]; foreignKeys: string[]; indexes: string[]; triggers: string[] }>;
};

const GUARD_TRIGGERS = [
  'partner_credit_lots_inert_guard',
  'partner_credit_ledger_insert_disabled',
  'partner_credit_reservations_inert_guard',
  'pc_multiunit_allocation_inert_guard',
  'pc_multiunit_movement_inert_guard',
];
const GUARD_CONSTRAINTS = [
  'pc_multiunit_exact_conservation',
  'pc_multiunit_lot_once',
  'pc_multiunit_decision_once',
  'partner_credit_multiunit_movements_idempotency_key_key',
];

describe.skipIf(!process.env.DATABASE_URL)('stripe evidence tables (migration 0045, integration)', () => {
  let c: Client;
  beforeAll(async () => {
    c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
  });
  afterAll(async () => {
    await c.end();
  });

  const names = (rows: { n: string }[]) => rows.map(r => r.n);

  it('T44: catalog equals the contract exactly (columns, checks, uniques, foreign keys, indexes, triggers)', async () => {
    for (const [table, want] of Object.entries(contract.tables)) {
      const q = async (sql: string) => names((await c.query(sql, [table])).rows);
      expect(await q(`select a.attname n from pg_attribute a where a.attrelid=('public.'||$1)::regclass and a.attnum>0 and not a.attisdropped order by a.attnum`), table).toEqual(want.columns);
      for (const [kind, key] of [['c', 'checks'], ['u', 'uniques'], ['f', 'foreignKeys']] as const) {
        expect(await q(`select conname n from pg_constraint where conrelid=('public.'||$1)::regclass and contype='${kind}' order by conname`), `${table} ${key}`).toEqual(want[key]);
      }
      expect(await q(`select indexname n from pg_indexes where schemaname='public' and tablename=$1 and indexname not like '%_pkey' order by indexname`), `${table} indexes`).toEqual(want.indexes);
      expect(await q(`select tgname n from pg_trigger where tgrelid=('public.'||$1)::regclass and not tgisinternal order by tgname`), `${table} triggers`).toEqual(want.triggers);
    }
  });

  it('T27: the five economic guards are enabled and the four constraints validated', async () => {
    const t = await c.query(`select tgname, tgenabled from pg_trigger where tgname = any($1::text[])`, [GUARD_TRIGGERS]);
    expect(t.rowCount).toBe(5);
    expect(t.rows.every(r => r.tgenabled === 'O')).toBe(true);
    const k = await c.query(`select conname, convalidated from pg_constraint where conname = any($1::text[])`, [GUARD_CONSTRAINTS]);
    expect(k.rowCount).toBe(4);
    expect(k.rows.every(r => r.convalidated)).toBe(true);
  });

  it('adds no foreign key from the evidence tables to an economic table (only dispositions.business_id -> businesses)', async () => {
    const r = await c.query(
      `select conrelid::regclass::text t, confrelid::regclass::text ref from pg_constraint
       where contype='f' and conrelid::regclass::text = any($1::text[])`,
      [Object.keys(contract.tables)],
    );
    const external = r.rows.filter(x => !Object.keys(contract.tables).includes(x.ref));
    expect(external).toEqual([{ t: 'stripe_provider_event_dispositions', ref: 'businesses' }]);
  });

  describe('constraint behaviour (single rolled-back transaction)', () => {
    beforeAll(async () => {
      await c.query('begin');
    });
    afterAll(async () => {
      await c.query('rollback');
    });

    const attempt = async (sql: string, params: unknown[] = []) => {
      await c.query('savepoint s');
      try {
        await c.query(sql, params);
        await c.query('release savepoint s');
        return null;
      } catch (e) {
        await c.query('rollback to savepoint s');
        return (e as Error).message;
      }
    };
    const control = (kind: string, details: unknown, extra: { stream?: string; dedupe?: string; cause?: string } = {}) =>
      attempt(
        `insert into stripe_evidence_control_events(event_kind, actor, details, stream, dedupe_key, cause) values ($1,'test',$2::jsonb,$3,$4,$5)`,
        [kind, JSON.stringify(details), extra.stream ?? null, extra.dedupe ?? null, extra.cause ?? null],
      );

    const evidence = { e1_custody_inventory: true, e2_two_person_attestation: true, e3_platform_evidence: true, e4_independent_signoff: true, e5_negative_tests_run: true };

    it('T42: kek_destroyed claim and evidence shape fail closed', async () => {
      expect(await control('kek_destroyed', { claim: 'irrecoverable_verified' })).toMatch(/kek_destroyed_claim/);
      expect(await control('kek_destroyed', { claim: 'irrecoverable_verified', evidence, evidence_refs: [] })).toMatch(/kek_destroyed_claim/);
      expect(await control('kek_destroyed', { claim: 'irrecoverable_verified', evidence: { ...evidence, e3_platform_evidence: false }, evidence_refs: ['r'] })).toMatch(/kek_destroyed_claim/);
      expect(await control('kek_destroyed', { claim: 'nonsense' })).toMatch(/kek_destroyed_claim/);
      expect(await control('kek_destroyed', {})).toMatch(/kek_destroyed_claim/);
      expect(await control('kek_destroyed', { claim: 'conditional' })).toBeNull();
      expect(await control('kek_destroyed', { claim: 'irrecoverable_verified', evidence, evidence_refs: ['ref-1'] })).toBeNull();
    });

    it('T43 (constraints): stream, dedupe key, cause and attestation result are mandatory where specified', async () => {
      expect(await control('capture_heartbeat', {})).toMatch(/stream_dedupe_required/);
      expect(await control('ucw_opened', {}, { stream: 'acct_1:true', dedupe: 'd0' })).toMatch(/cause_required/);
      expect(await control('ucw_opened', {}, { stream: 'acct_1:true', dedupe: 'd0', cause: 'bogus' })).toMatch(/cause_required/);
      expect(await control('ucw_opened', {}, { stream: 'acct_1:true', dedupe: 'd1', cause: 'capture_off' })).toBeNull();
      expect(await control('ucw_opened', {}, { stream: 'acct_1:true', dedupe: 'd1', cause: 'capture_off' })).toMatch(/dedupe_key_uq|duplicate key/);
      expect(await control('account_provenance_verified', {})).toMatch(/attestation_result/);
      expect(await control('account_provenance_verified', { result: 'passed' })).toBeNull();
      expect(await control('not_a_kind', {})).toMatch(/kind_check/);
    });

    it('T26: UPDATE, DELETE and TRUNCATE are rejected on every evidence table', async () => {
      await control('legal_hold_set', {});
      expect(await attempt(`update stripe_evidence_control_events set actor='x'`)).toMatch(/append-only/);
      expect(await attempt(`delete from stripe_evidence_control_events`)).toMatch(/append-only/);
      for (const table of Object.keys(contract.tables)) {
        const msg = await attempt(`truncate ${table} cascade`);
        expect(msg, table).toMatch(/append-only/);
      }
    });

    let attestationId: string;
    const DIGEST = Buffer.alloc(32, 7);
    const NONCE = Buffer.alloc(12, 1);

    it('T40: key rows enforce cohort pattern and uniqueness', async () => {
      const ins = (cohort: string, kek: string) =>
        attempt(`insert into stripe_evidence_keys(cohort,kek_version,wrapped_dek,wrap_nonce,wrap_algorithm,dek_fingerprint) values ($1,$2,$3,$4,'AES-256-GCM',$5)`, [cohort, kek, Buffer.alloc(48), NONCE, DIGEST]);
      expect(await ins('2026-13', 'v1')).toMatch(/cohort_check/);
      expect(await ins('2026-10', 'v1')).toBeNull();
      expect(await ins('2026-10', 'v1')).toMatch(/cohort_kek_uq|duplicate key/);
      expect(await ins('2026-10:legal_hold', 'v1')).toBeNull();
      const r = await c.query(`insert into stripe_evidence_control_events(event_kind,actor,details) values ('account_provenance_verified','test','{"result":"passed"}') returning id`);
      attestationId = r.rows[0].id;
    });

    const eventSql = `insert into stripe_provider_events(
      receiving_account_id,event_account_id,account_scope,livemode,stripe_event_id,provenance,attestation_event_id,event_type,
      provider_created_unix,provider_created_at,received_at,payload_sha256,payload_ciphertext,payload_nonce,payload_key_cohort,kek_version,payload_bytes,
      sig_header_timestamp,sig_scheme,signing_secret_label,verified_at,verifier_version,retrieved_at,retrieval_run_id,retrieval_api_version,
      capture_mode,projection_mode,retention_policy_version,retain_until)
      values ($1,$2,$3,false,$4,$5,$6,'customer.subscription.updated',1700000000,to_timestamp(1700000000),now(),$7,$8,$9,'2026-10','v1',10,
      $10,$11,$12,$13,$14,$15,$16,$17,'enforced','legacy','v1',now()+interval '1 year') returning id`;
    const sigGroup = [1700000001, 'v1', 'primary', new Date(), 'v1', null, null, null];
    const run = (
      recv: string, ev: string, scope: string, evtId: string, prov: string,
      group: unknown[] = sigGroup, created?: never,
    ) => attempt(eventSql, [recv, ev, scope, evtId, prov, attestationId, DIGEST, Buffer.from('x'), NONCE, ...group]);

    it('T36/T32/T03: scope, provenance groups and identity uniqueness', async () => {
      expect(await run('acct_A', 'acct_B', 'direct', 'evt_1', 'webhook_signature')).toMatch(/scope_check/);
      expect(await run('acct_A', 'acct_A', 'connect', 'evt_1', 'webhook_signature')).toMatch(/scope_check/);
      expect(await run('bad', 'bad', 'direct', 'evt_1', 'webhook_signature')).toMatch(/acct_check/);
      expect(await run('acct_A', 'acct_A', 'direct', 'bad_id', 'webhook_signature')).toMatch(/event_id_check/);
      expect(await run('acct_A', 'acct_A', 'direct', 'evt_1', 'webhook_signature', [null, null, null, null, null, null, null, null])).toMatch(/provenance_groups_check/);
      // retrieval provenance carrying signature columns is rejected: retrieval evidence can never pose as webhook evidence
      expect(await run('acct_A', 'acct_A', 'direct', 'evt_1', 'api_retrieval')).toMatch(/provenance_groups_check/);
      expect(await run('acct_A', 'acct_A', 'direct', 'evt_1', 'webhook_signature')).toBeNull();
      expect(await run('acct_A', 'acct_A', 'direct', 'evt_1', 'webhook_signature')).toMatch(/identity_uq|duplicate key/);
      expect(await run('acct_A', 'acct_B', 'connect', 'evt_1', 'webhook_signature')).toBeNull();
    });

    it('T35: malformed receipts require a signature group, defects and QR_SHAPE_INVALID; digest is unique', async () => {
      const ins = (digest: Buffer, defects: string[], reasons: string[], status = 'not_json', scheme = 'v1') =>
        attempt(
          `insert into stripe_provider_malformed_receipts(received_at,payload_sha256,payload_ciphertext,payload_nonce,payload_key_cohort,kek_version,payload_bytes,
            sig_header_timestamp,sig_scheme,signing_secret_label,verified_at,verifier_version,parse_status,shape_defects,reason_codes,receiving_account_id,attestation_event_id,
            capture_mode,projection_mode,retention_policy_version,retain_until)
           values (now(),$1,$2,$3,'2026-10','v1',3,1700000001,$4,'primary',now(),'v1',$5,$6::text[],$7::text[],'acct_A',$8,'enforced','legacy','v1',now()+interval '1 year')`,
          [digest, Buffer.from('x'), NONCE, scheme, status, defects, reasons, attestationId],
        );
      const d1 = Buffer.alloc(32, 1);
      expect(await ins(d1, [], ['QR_SHAPE_INVALID'])).toMatch(/defects_check/);
      expect(await ins(d1, ['made_up'], ['QR_SHAPE_INVALID'])).toMatch(/defects_check/);
      expect(await ins(d1, ['missing_id'], ['OTHER'])).toMatch(/reason_check/);
      expect(await ins(d1, ['missing_id'], ['QR_SHAPE_INVALID'], 'weird')).toMatch(/parse_status_check/);
      expect(await ins(d1, ['missing_id'], ['QR_SHAPE_INVALID'], 'not_json', 'v0')).toMatch(/sig_scheme_check/);
      expect(await ins(d1, ['missing_id', 'bad_created'], ['QR_SHAPE_INVALID'])).toBeNull();
      expect(await ins(d1, ['missing_id'], ['QR_SHAPE_INVALID'])).toMatch(/digest_uq|duplicate key/);
    });

    it('T38: a claim row needs attempt, claimant and lease, and one claim per (event, attempt)', async () => {
      const ev = (await c.query(`select id from stripe_provider_events limit 1`)).rows[0].id;
      const claim = (attemptNo: number | null, claimant: string | null, lease: Date | null, kind = 'processing_claimed') =>
        attempt(
          `insert into stripe_provider_event_dispositions(event_record_id,disposition,actor,rule_version,attempt_no,claimant,lease_expires_at) values ($1,$2,'t','v1',$3,$4,$5)`,
          [ev, kind, attemptNo, claimant, lease],
        );
      const later = new Date(Date.now() + 600000);
      expect(await claim(null, 'w1', later)).toMatch(/claim_fields_check/);
      expect(await claim(1, null, later)).toMatch(/claim_fields_check/);
      expect(await claim(1, 'w1', null)).toMatch(/claim_fields_check/);
      expect(await claim(1, 'w1', later)).toBeNull();
      expect(await claim(1, 'w2', later)).toMatch(/claim_uq|duplicate key/);
      expect(await claim(2, 'w2', later)).toBeNull();
      expect(await claim(1, 'w1', null, 'projection_applied')).toBeNull();
      expect(await claim(null, null, null, 'bogus')).toMatch(/kind_check/);
    });
  });
});
