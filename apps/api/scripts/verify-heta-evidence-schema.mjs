/**
 * Disposable migrated PostgreSQL only. Synthetic evidence is rolled back;
 * no Stripe calls, cryptographic claims, financial writes or trigger disabling.
 * This verifies storage constraints, not historical-tier certification or RLS.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

if (process.env.SPLIT07_DISPOSABLE_DB !== 'I_ACKNOWLEDGE' || !process.env.DATABASE_URL)
  throw new Error('Disposable database acknowledgement and DATABASE_URL required');

const tables = [
  'stripe_evidence_control_events',
  'stripe_evidence_keys',
  'stripe_provider_events',
  'stripe_provider_malformed_receipts',
  'stripe_provider_event_dispositions',
  'stripe_provider_event_conflicts',
];
const db = new Client({ connectionString: process.env.DATABASE_URL });
let checks = 0;
// Identifiers come only from fixed source constants, never environment/user input.
async function insert(table, fields) {
  const columns = Object.keys(fields);
  const result = await db.query(
    `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    Object.values(fields),
  );
  return result.rows[0].id;
}
async function denied(label, run, code, constraint) {
  await db.query('SAVEPOINT denied_write');
  let failure;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  await db.query('ROLLBACK TO SAVEPOINT denied_write');
  await db.query('RELEASE SAVEPOINT denied_write');
  assert.equal(failure?.code, code, `${label}: expected SQLSTATE ${code}`);
  // PostgreSQL truncates these ASCII Drizzle identifiers to 63 bytes.
  if (constraint) assert.equal(failure.constraint, constraint.slice(0, 63), label);
  checks++;
}

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL statement_timeout = '10s'");
  await db.query("SET LOCAL lock_timeout = '2s'");
  const triggers = await db.query(
    `
    SELECT c.relname, t.tgname, t.tgtype::int, t.tgenabled,
           p.proname, n.nspname
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE NOT t.tgisinternal AND n.nspname='public' AND c.relname=ANY($1::text[])`,
    [tables],
  );
  for (const table of tables) {
    // BEFORE ROW UPDATE/DELETE = 27; BEFORE STATEMENT TRUNCATE = 34.
    for (const [suffix, type] of [
      ['no_update_delete', 27],
      ['no_truncate', 34],
    ]) {
      const trigger = triggers.rows.find(
        (t) => t.relname === table && t.tgname === `${table}_${suffix}`,
      );
      assert.ok(trigger, `${table}: missing ${suffix}`);
      assert.equal(trigger.tgtype, type);
      assert.equal(trigger.tgenabled, 'O');
      assert.equal(trigger.proname, 'stripe_provider_evidence_immutable');
      checks++;
    }
  }
  const guards = [
    'partner_credit_lots_inert_guard',
    'partner_credit_ledger_insert_disabled',
    'partner_credit_reservations_inert_guard',
    'pc_multiunit_allocation_inert_guard',
    'pc_multiunit_movement_inert_guard',
  ];
  const installed = await db.query(
    `SELECT tgname FROM pg_trigger
    WHERE NOT tgisinternal AND tgenabled='O' AND tgname=ANY($1::text[])`,
    [guards],
  );
  assert.deepEqual(new Set(installed.rows.map((t) => t.tgname)), new Set(guards));
  checks++;

  const marker = randomUUID();
  const control = {
    event_kind: 'account_provenance_verified',
    actor: 'synthetic-schema-verifier',
    details: { result: 'passed' },
  };
  const attestation = await insert(tables[0], control);
  const key = {
    cohort: '2099-01',
    kek_version: `fixture-${marker}`,
    wrapped_dek: Buffer.alloc(32, 1),
    wrap_nonce: Buffer.alloc(12, 2),
    wrap_algorithm: 'AES-256-GCM',
    dek_fingerprint: Buffer.alloc(32, 3),
  };
  const keyId = await insert(tables[1], key);
  const payload = {
    payload_ciphertext: Buffer.alloc(32, 4),
    payload_nonce: Buffer.alloc(12, 5),
    payload_key_cohort: key.cohort,
    kek_version: key.kek_version,
  };
  const signature = {
    sig_header_timestamp: 1,
    sig_scheme: 'v1',
    signing_secret_label: 'fixture-only',
    verified_at: new Date('2099-01-01T00:00:00Z'),
    verifier_version: 'fixture-only',
  };
  const receipt = {
    ...payload,
    ...signature,
    received_at: new Date('2099-01-01T00:00:00Z'),
    payload_sha256: Buffer.alloc(32, 6),
    payload_bytes: 32,
    receiving_account_id: 'acct_schemaFixture',
    attestation_event_id: attestation,
    capture_mode: 'enforced',
    projection_mode: 'legacy',
    retention_policy_version: 'fixture-only',
    retain_until: new Date('2099-02-01T00:00:00Z'),
  };
  const event = {
    ...receipt,
    event_account_id: receipt.receiving_account_id,
    account_scope: 'direct',
    livemode: false,
    stripe_event_id: `evt_${marker.replaceAll('-', '')}`,
    provenance: 'webhook_signature',
    event_type: 'fixture.schema',
    provider_created_unix: 1,
    provider_created_at: new Date(1000),
  };
  const eventId = await insert(tables[2], event);
  const malformedId = await insert(tables[3], {
    ...receipt,
    parse_status: 'json_object_invalid_envelope',
    shape_defects: ['missing_id'],
    reason_codes: ['QR_SHAPE_INVALID'],
  });
  const dispositionId = await insert(tables[4], {
    event_record_id: eventId,
    disposition: 'capture_committed',
    actor: 'synthetic-schema-verifier',
    rule_version: 'fixture-only',
  });
  const conflictId = await insert(tables[5], {
    ...payload,
    ...signature,
    event_record_id: eventId,
    conflict_kind: 'webhook_digest_mismatch',
    conflicting_provenance: 'webhook_signature',
    conflicting_sha256: Buffer.alloc(32, 7),
  });

  for (const [i, id] of [
    attestation,
    keyId,
    eventId,
    malformedId,
    dispositionId,
    conflictId,
  ].entries()) {
    const table = tables[i];
    await denied(
      `${table} UPDATE`,
      () => db.query(`UPDATE ${table} SET id=id WHERE id=$1`, [id]),
      'P0001',
    );
    await denied(
      `${table} DELETE`,
      () => db.query(`DELETE FROM ${table} WHERE id=$1`, [id]),
      'P0001',
    );
  }
  // Truncate all six together so FK validation cannot mask the actual trigger denial.
  await denied('all evidence TRUNCATE', () => db.query(`TRUNCATE ${tables.join(',')}`), 'P0001');

  for (const [kind, details, constraint] of [
    ['account_provenance_verified', {}, 'stripe_evidence_control_attestation_result'],
    ['kek_destroyed', {}, 'stripe_evidence_control_kek_destroyed_claim'],
    [
      'kek_destroyed',
      { claim: 'irrecoverable_verified' },
      'stripe_evidence_control_kek_destroyed_claim',
    ],
  ]) {
    await denied(
      `missing ${kind} proof`,
      () => insert(tables[0], { ...control, event_kind: kind, details }),
      '23514',
      constraint,
    );
  }
  await denied(
    'missing coverage-gap cause',
    () =>
      insert(tables[0], {
        ...control,
        event_kind: 'ucw_opened',
        stream: 'fixture',
        dedupe_key: marker,
      }),
    '23514',
    'stripe_evidence_control_cause_required',
  );
  await denied(
    'duplicate key identity',
    () => insert(tables[1], key),
    '23505',
    'stripe_evidence_keys_cohort_kek_uq',
  );
  await denied(
    'duplicate event identity',
    () => insert(tables[2], event),
    '23505',
    'stripe_provider_events_identity_uq',
  );
  for (const [label, changes, code, constraint] of [
    [
      'foreign encryption key',
      { kek_version: 'missing' },
      '23503',
      'stripe_provider_events_key_fk',
    ],
    [
      'foreign attestation',
      { attestation_event_id: randomUUID() },
      '23503',
      'stripe_provider_events_attestation_event_id_stripe_evidence_control_events_id_fk',
    ],
    [
      'direct account mismatch',
      { event_account_id: 'acct_otherFixture' },
      '23514',
      'stripe_provider_events_scope_check',
    ],
    [
      'mixed provenance',
      { retrieved_at: new Date() },
      '23514',
      'stripe_provider_events_provenance_groups_check',
    ],
    [
      'short digest',
      { payload_sha256: Buffer.alloc(31) },
      '23514',
      'stripe_provider_events_digest_check',
    ],
    [
      'mismatched provider time',
      { provider_created_unix: 2 },
      '23514',
      'stripe_provider_events_created_check',
    ],
  ]) {
    await denied(
      label,
      () =>
        insert(tables[2], {
          ...event,
          stripe_event_id: `evt_${randomUUID().replaceAll('-', '')}`,
          ...changes,
        }),
      code,
      constraint,
    );
  }
  await db.query('ROLLBACK');
  for (const [i, id] of [
    attestation,
    keyId,
    eventId,
    malformedId,
    dispositionId,
    conflictId,
  ].entries()) {
    assert.equal((await db.query(`SELECT id FROM ${tables[i]} WHERE id=$1`, [id])).rowCount, 0);
    checks++;
  }
  console.log(
    `PASS: ${checks} HETA schema/append-only/rollback checks; economic guards installed; no activation`,
  );
} finally {
  await db.query('ROLLBACK').catch(() => {});
  await db.end();
}
