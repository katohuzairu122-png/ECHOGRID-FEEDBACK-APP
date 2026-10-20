import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Synthetic storage tests only. Uses the existing disposable integration tier.
 * Characterization cases intentionally demonstrate missing semantic checks;
 * their acceptance by SQL is NOT approval to trust or wire these records.
 * No Stripe calls, economic writes, role changes or disabled triggers.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  'Stripe evidence storage boundaries (real Postgres)',
  () => {
    let db: Client;
    let attestationId: string;
    let keyVersion: string;
    let event: Record<string, unknown>;
    const at = new Date('2099-01-01T00:00:00Z');
    const tables = [
      'stripe_evidence_control_events',
      'stripe_evidence_keys',
      'stripe_provider_events',
      'stripe_provider_malformed_receipts',
      'stripe_provider_event_dispositions',
      'stripe_provider_event_conflicts',
    ];

    // SQL identifiers are fixed test-source constants; values are parameterized.
    async function insert(table: string, fields: Record<string, unknown>): Promise<string> {
      const columns = Object.keys(fields);
      const result = await db.query<{ id: string }>(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
        Object.values(fields),
      );
      return result.rows[0]!.id;
    }

    async function rejectsAt(run: () => Promise<unknown>, code: string, constraint: string) {
      await db.query('SAVEPOINT rejected_fixture');
      let failure: unknown;
      try {
        await run();
      } catch (error) {
        failure = error;
      }
      await db.query('ROLLBACK TO SAVEPOINT rejected_fixture');
      await db.query('RELEASE SAVEPOINT rejected_fixture');
      expect(failure).toMatchObject({ code, constraint: constraint.slice(0, 63) });
    }

    beforeAll(async () => {
      db = new Client({ connectionString: process.env.DATABASE_URL });
      await db.connect();
    });
    afterAll(async () => {
      if (db) await db.end();
    });
    beforeEach(async () => {
      await db.query('BEGIN');
      await db.query("SET LOCAL statement_timeout = '10s'");
      await db.query("SET LOCAL lock_timeout = '2s'");
      attestationId = await insert(tables[0]!, {
        event_kind: 'account_provenance_verified',
        actor: 'synthetic-boundary-test',
        details: { result: 'passed' },
      });
      keyVersion = `fixture-${randomUUID()}`;
      await insert(tables[1]!, {
        cohort: '2099-01',
        kek_version: keyVersion,
        wrapped_dek: Buffer.alloc(32, 1),
        wrap_nonce: Buffer.alloc(12, 2),
        wrap_algorithm: 'AES-256-GCM',
        dek_fingerprint: Buffer.alloc(32, 3),
      });
      event = {
        receiving_account_id: 'acct_fixtureReceiver',
        event_account_id: 'acct_fixtureReceiver',
        account_scope: 'direct',
        livemode: false,
        stripe_event_id: `evt_${randomUUID().replaceAll('-', '')}`,
        provenance: 'webhook_signature',
        attestation_event_id: attestationId,
        event_type: 'fixture.boundaries',
        provider_created_unix: 1,
        provider_created_at: new Date(1000),
        received_at: at,
        payload_sha256: Buffer.alloc(32, 4),
        payload_ciphertext: Buffer.alloc(32, 5),
        payload_nonce: Buffer.alloc(12, 6),
        payload_key_cohort: '2099-01',
        kek_version: keyVersion,
        payload_bytes: 32,
        sig_header_timestamp: 1,
        sig_scheme: 'v1',
        signing_secret_label: 'fixture-only',
        verified_at: at,
        verifier_version: 'fixture-only',
        capture_mode: 'enforced',
        projection_mode: 'legacy',
        retention_policy_version: 'fixture-only',
        retain_until: new Date('2099-02-01T00:00:00Z'),
      };
    });
    afterEach(async () => {
      await db.query('ROLLBACK');
      // Confirm fixture state was not persisted, even when a test expected SQL rejection.
      if (attestationId)
        expect(
          (
            await db.query('SELECT id FROM stripe_evidence_control_events WHERE id=$1', [
              attestationId,
            ])
          ).rowCount,
        ).toBe(0);
      if (keyVersion)
        expect(
          (await db.query('SELECT id FROM stripe_evidence_keys WHERE kek_version=$1', [keyVersion]))
            .rowCount,
        ).toBe(0);
    });

    describe('enforced constraints', () => {
      it('rejects identical replay within the same full SQL identity', async () => {
        const id = await insert(tables[2]!, event);
        await rejectsAt(
          () => insert(tables[2]!, event),
          '23505',
          'stripe_provider_events_identity_uq',
        );
        expect(
          (
            await db.query('SELECT id FROM stripe_provider_events WHERE stripe_event_id=$1', [
              event.stripe_event_id,
            ])
          ).rows,
        ).toEqual([{ id }]);
      });

      it('rejects a different digest under the same provenance without replacing the original', async () => {
        const id = await insert(tables[2]!, event);
        await rejectsAt(
          () => insert(tables[2]!, { ...event, payload_sha256: Buffer.alloc(32, 9) }),
          '23505',
          'stripe_provider_events_identity_uq',
        );
        const stored = await db.query<{ payload_sha256: Buffer }>(
          'SELECT payload_sha256 FROM stripe_provider_events WHERE id=$1',
          [id],
        );
        expect(stored.rows[0]!.payload_sha256).toEqual(event.payload_sha256);
        // SQL denial alone does not append a conflict receipt or implement replay recovery.
        expect(
          (
            await db.query(
              'SELECT id FROM stripe_provider_event_conflicts WHERE event_record_id=$1',
              [id],
            )
          ).rowCount,
        ).toBe(0);
      });

      it('keeps test/live mode identities distinct in storage', async () => {
        const a = await insert(tables[2]!, event);
        const b = await insert(tables[2]!, { ...event, livemode: true });
        expect(a).not.toBe(b);
        const rows = await db.query(
          'SELECT livemode FROM stripe_provider_events WHERE stripe_event_id=$1 ORDER BY livemode',
          [event.stripe_event_id],
        );
        expect(rows.rows).toEqual([{ livemode: false }, { livemode: true }]);
      });

      it('keeps receiving-account identities distinct', async () => {
        const a = await insert(tables[2]!, event);
        const b = await insert(tables[2]!, {
          ...event,
          receiving_account_id: 'acct_fixtureOther',
          event_account_id: 'acct_fixtureOther',
        });
        expect(a).not.toBe(b);
      });

      it('keeps distinct connected event accounts under one receiver distinct', async () => {
        const a = await insert(tables[2]!, {
          ...event,
          account_scope: 'connect',
          event_account_id: 'acct_fixtureConnectedA',
        });
        const b = await insert(tables[2]!, {
          ...event,
          account_scope: 'connect',
          event_account_id: 'acct_fixtureConnectedB',
        });
        expect(a).not.toBe(b);
      });

      it('rejects a direct-scope event with different receiving and event accounts', async () => {
        await rejectsAt(
          () => insert(tables[2]!, { ...event, event_account_id: 'acct_fixtureOther' }),
          '23514',
          'stripe_provider_events_scope_check',
        );
      });

      it('rejects a nonexistent attestation reference', async () => {
        await rejectsAt(
          () => insert(tables[2]!, { ...event, attestation_event_id: randomUUID() }),
          '23503',
          'stripe_provider_events_attestation_event_id_stripe_evidence_control_events_id_fk',
        );
      });

      it('preserves all five installed financial denial triggers', async () => {
        const expected = [
          'partner_credit_lots_inert_guard',
          'partner_credit_ledger_insert_disabled',
          'partner_credit_reservations_inert_guard',
          'pc_multiunit_allocation_inert_guard',
          'pc_multiunit_movement_inert_guard',
        ];
        const actual = await db.query<{ tgname: string }>(
          `SELECT tgname FROM pg_trigger
        WHERE NOT tgisinternal AND tgenabled='O' AND tgname=ANY($1::text[])`,
          [expected],
        );
        expect(actual.rows.map((r) => r.tgname).sort()).toEqual([...expected].sort());
      });
    });

    describe('characterization of unresolved semantic gaps — not approved behavior', () => {
      it('R1: allows contradictory webhook/API payloads to coexist because provenance is in the SQL identity', async () => {
        const webhookId = await insert(tables[2]!, event);
        const runId = await insert(tables[0]!, {
          event_kind: 'reconciliation_run',
          actor: 'synthetic-boundary-test',
        });
        const apiId = await insert(tables[2]!, {
          ...event,
          provenance: 'api_retrieval',
          payload_sha256: Buffer.alloc(32, 9),
          sig_header_timestamp: null,
          sig_scheme: null,
          signing_secret_label: null,
          verified_at: null,
          verifier_version: null,
          retrieved_at: at,
          retrieval_run_id: runId,
          retrieval_api_version: 'fixture-only',
        });
        expect(apiId).not.toBe(webhookId);
        const rows = await db.query(
          'SELECT provenance FROM stripe_provider_events WHERE stripe_event_id=$1 ORDER BY provenance',
          [event.stripe_event_id],
        );
        expect(rows.rows).toEqual([
          { provenance: 'api_retrieval' },
          { provenance: 'webhook_signature' },
        ]);
        expect(
          (
            await db.query(
              'SELECT id FROM stripe_provider_event_conflicts WHERE event_record_id=ANY($1::uuid[])',
              [[webhookId, apiId]],
            )
          ).rowCount,
        ).toBe(0);
      });

      it('R2: rejects an identical malformed digest from a different account at the global digest index', async () => {
        const malformed = {
          received_at: at,
          payload_sha256: Buffer.alloc(32, 7),
          payload_ciphertext: Buffer.alloc(32, 8),
          payload_nonce: Buffer.alloc(12, 6),
          payload_key_cohort: '2099-01',
          kek_version: keyVersion,
          payload_bytes: 32,
          sig_header_timestamp: 1,
          sig_scheme: 'v1',
          signing_secret_label: 'fixture-only',
          verified_at: at,
          verifier_version: 'fixture-only',
          parse_status: 'json_object_invalid_envelope',
          shape_defects: ['missing_id'],
          reason_codes: ['QR_SHAPE_INVALID'],
          receiving_account_id: 'acct_fixtureReceiver',
          attestation_event_id: attestationId,
          capture_mode: 'enforced',
          projection_mode: 'legacy',
          retention_policy_version: 'fixture-only',
          retain_until: new Date('2099-02-01T00:00:00Z'),
        };
        const first = await insert(tables[3]!, malformed);
        await rejectsAt(
          () =>
            insert(tables[3]!, {
              ...malformed,
              receiving_account_id: 'acct_fixtureOther',
              signing_secret_label: 'another-fixture-context',
            }),
          '23505',
          'stripe_provider_malformed_receipts_digest_uq',
        );
        expect(
          (
            await db.query(
              'SELECT id,receiving_account_id FROM stripe_provider_malformed_receipts WHERE payload_sha256=$1',
              [malformed.payload_sha256],
            )
          ).rows,
        ).toEqual([{ id: first, receiving_account_id: 'acct_fixtureReceiver' }]);
      });

      it('R3: accepts a referenced failed attestation; existence is not successful verification', async () => {
        const failed = await insert(tables[0]!, {
          event_kind: 'account_provenance_verified',
          actor: 'synthetic-boundary-test',
          details: { result: 'failed' },
        });
        const id = await insert(tables[2]!, { ...event, attestation_event_id: failed });
        expect(
          (
            await db.query('SELECT attestation_event_id FROM stripe_provider_events WHERE id=$1', [
              id,
            ])
          ).rows[0],
        ).toEqual({ attestation_event_id: failed });
      });

      it('R3: accepts the wrong control-event kind as an attestation reference', async () => {
        const wrongKind = await insert(tables[0]!, {
          event_kind: 'reconciliation_run',
          actor: 'synthetic-boundary-test',
        });
        expect(
          await insert(tables[2]!, { ...event, attestation_event_id: wrongKind }),
        ).toBeTruthy();
      });

      it('R3: does not bind attestation detail account, mode or validity window to the receipt', async () => {
        const mismatched = await insert(tables[0]!, {
          event_kind: 'account_provenance_verified',
          actor: 'synthetic-boundary-test',
          details: {
            result: 'passed',
            account_id: 'acct_unrelatedFixture',
            livemode: true,
            valid_until: '2000-01-01T00:00:00Z',
          },
        });
        // These detail keys are synthetic probes, not a proposed attestation contract.
        expect(
          await insert(tables[2]!, { ...event, attestation_event_id: mismatched }),
        ).toBeTruthy();
      });

      it('R4: records absent evidence-table RLS without claiming runtime tenant isolation', async () => {
        const rows = await db.query<{
          relname: string;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
          policies: number;
        }>(
          `
        SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
               (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
          [tables],
        );
        expect(rows.rowCount).toBe(6);
        for (const row of rows.rows)
          expect(row).toMatchObject({
            relrowsecurity: false,
            relforcerowsecurity: false,
            policies: 0,
          });
        const role = await db.query<{
          rolsuper: boolean;
          rolbypassrls: boolean;
          owns_evidence_table: boolean;
        }>(
          `
        SELECT r.rolsuper,r.rolbypassrls,
          EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND c.relowner=r.oid) AS owns_evidence_table
        FROM pg_roles r WHERE r.rolname=current_user`,
          [tables],
        );
        expect(role.rowCount).toBe(1);
        // Only capability booleans, no role names or credentials. This is the disposable test role.
        console.warn('Disposable HETA test-role capabilities (not production):', role.rows[0]);
      });
    });
  },
);
