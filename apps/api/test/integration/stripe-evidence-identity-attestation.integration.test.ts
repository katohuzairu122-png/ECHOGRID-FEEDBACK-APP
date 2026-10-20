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
  'Block F identity/attestation characterization (real Postgres)',
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
      expect(failure).toMatchObject({ code });
      if (constraint) expect(failure).toMatchObject({ constraint: constraint.slice(0, 63) });
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
        actor: 'synthetic-block-f-test',
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

    async function control(details: Record<string, unknown>, extra: Record<string, unknown> = {}) {
      return insert(tables[0]!, {
        event_kind: 'account_provenance_verified',
        actor: 'synthetic-block-f-test',
        details,
        ...extra,
      });
    }
    async function apiReceipt(extra: Record<string, unknown> = {}) {
      const run = await insert(tables[0]!, {
        event_kind: 'reconciliation_run',
        actor: 'synthetic-block-f-test',
      });
      return {
        ...event,
        provenance: 'api_retrieval',
        sig_header_timestamp: null,
        sig_scheme: null,
        signing_secret_label: null,
        verified_at: null,
        verifier_version: null,
        retrieved_at: at,
        retrieval_run_id: run,
        retrieval_api_version: 'synthetic-only',
        ...extra,
      };
    }
    async function noAutomaticDecision(ids: string[]) {
      for (const table of [tables[4]!, tables[5]!])
        expect(
          (
            await db.query('SELECT id FROM ' + table + ' WHERE event_record_id=ANY($1::uuid[])', [
              ids,
            ])
          ).rowCount,
        ).toBe(0);
    }
    describe('F-A: storage identity, not a canonical provider authority algorithm', () => {
      it.each(['webhook-first', 'api-first'])(
        'characterization: %s preserves separate rows without reconciliation',
        async (order) => {
          const api = await apiReceipt({
            payload_sha256: Buffer.alloc(32, 9),
            event_type: 'synthetic.contradiction',
          });
          const ids = [];
          for (const incoming of order === 'webhook-first' ? [event, api] : [api, event])
            ids.push(await insert(tables[2]!, incoming));
          expect(new Set(ids).size).toBe(2);
          await noAutomaticDecision(ids);
        },
      );
      it('characterization: equal cross-provenance digests still create separate records', async () => {
        const ids = [await insert(tables[2]!, event), await insert(tables[2]!, await apiReceipt())];
        expect(ids[0]).not.toBe(ids[1]);
        await noAutomaticDecision(ids);
      });
      it('characterization: two receivers store the same connected event separately', async () => {
        const a = { ...event, account_scope: 'connect', event_account_id: 'acct_connectedFixture' };
        const ids = [
          await insert(tables[2]!, a),
          await insert(tables[2]!, { ...a, receiving_account_id: 'acct_secondReceiver' }),
        ];
        expect(ids[0]).not.toBe(ids[1]);
        await noAutomaticDecision(ids);
      });
      it('enforced: API provenance cannot retain webhook columns', async () => {
        await rejectsAt(
          async () => insert(tables[2]!, await apiReceipt({ sig_scheme: 'v1' })),
          '23514',
          'stripe_provider_events_provenance_groups_check',
        );
      });
      it('enforced: webhook provenance cannot retain retrieval columns', async () => {
        await rejectsAt(
          () => insert(tables[2]!, { ...event, retrieved_at: at }),
          '23514',
          'stripe_provider_events_provenance_groups_check',
        );
      });
      it('enforced: Connect scope requires distinct accounts, not authorization proof', async () => {
        await rejectsAt(
          () => insert(tables[2]!, { ...event, account_scope: 'connect' }),
          '23514',
          'stripe_provider_events_scope_check',
        );
      });
      it('characterization: SQL does not bind a digest to payload bytes or parsed account claims', async () => {
        expect(
          await insert(tables[2]!, {
            ...event,
            payload_sha256: Buffer.alloc(32, 99),
            claimed_business_id: 'untrusted-claim',
          }),
        ).toBeTruthy();
      });
    });
    describe('F-B: enforced reference and shape constraints', () => {
      it('rejects missing attestation', async () => {
        await rejectsAt(
          () => insert(tables[2]!, { ...event, attestation_event_id: null }),
          '23502',
          '',
        );
      });
      it('rejects nonexistent attestation', async () => {
        await rejectsAt(
          () => insert(tables[2]!, { ...event, attestation_event_id: randomUUID() }),
          '23503',
          'stripe_provider_events_attestation_event_id_stripe_evidence_control_events_id_fk',
        );
      });
      it.each([{}, { result: 'unknown' }])('rejects malformed outcome %j', async (details) => {
        await rejectsAt(
          () => control(details),
          '23514',
          'stripe_evidence_control_attestation_result',
        );
      });
      it('rejects duplicate non-null dedupe key, not all semantic duplicates', async () => {
        const dedupe_key = randomUUID();
        await control({ result: 'passed' }, { dedupe_key });
        await rejectsAt(
          () => control({ result: 'passed' }, { dedupe_key }),
          '23505',
          'stripe_evidence_control_dedupe_key_uq',
        );
      });
    });
    describe('F-B: SQL semantic gaps — NOT valid attestations', () => {
      const probes: [string, Record<string, unknown>, Record<string, unknown>][] = [
        ['failed outcome', { result: 'failed' }, {}],
        ['wrong event kind', {}, { event_kind: 'reconciliation_run' }],
        ['wrong account', { result: 'passed', account_id: 'acct_unrelatedFixture' }, {}],
        ['wrong mode', { result: 'passed', livemode: true }, {}],
        ['expired validity', { result: 'passed', valid_until: '2000-01-01T00:00:00Z' }, {}],
        [
          'future verification',
          { result: 'passed', verified_at: '2100-01-01T00:00:00Z' },
          { occurred_at: new Date('2100-01-01') },
        ],
        ['revoked claim', { result: 'passed', revoked: true }, {}],
        [
          'unverified Connect relationship',
          { result: 'passed', connected_account_verified: false },
          {},
        ],
        ['wrong event binding', { result: 'passed', stripe_event_id: 'evt_unrelatedFixture' }, {}],
        ['untrusted actor string', { result: 'passed' }, { actor: 'synthetic-unauthorized-claim' }],
        ['missing method/source/account/mode/time', { result: 'passed' }, {}],
      ];
      it.each(probes)('characterization: accepts %s', async (name, details, extra) => {
        // Detail keys are synthetic probes, not an approved attestation JSON contract.
        const ref = await control(details, extra);
        const receipt: Record<string, unknown> = { ...event, attestation_event_id: ref };
        if (name === 'unverified Connect relationship') {
          receipt.account_scope = 'connect';
          receipt.event_account_id = 'acct_unverifiedConnected';
        }
        const id = await insert(tables[2]!, receipt);
        expect(
          (
            await db.query('SELECT attestation_event_id FROM stripe_provider_events WHERE id=$1', [
              id,
            ])
          ).rows[0],
        ).toEqual({ attestation_event_id: ref });
        await noAutomaticDecision([id]);
      });
      it('characterization: duplicate attestations with null dedupe keys coexist', async () => {
        expect(await control({ result: 'passed' })).not.toBe(await control({ result: 'passed' }));
      });
      it('enforced immutability; later contradictory evidence does not revoke a reference automatically', async () => {
        const id = await insert(tables[2]!, event);
        await rejectsAt(
          () =>
            db.query("UPDATE stripe_evidence_control_events SET details='{}' WHERE id=$1", [
              attestationId,
            ]),
          'P0001',
          '',
        );
        await rejectsAt(
          () => db.query('DELETE FROM stripe_evidence_control_events WHERE id=$1', [attestationId]),
          'P0001',
          '',
        );
        expect(await control({ result: 'failed', supersedes: attestationId })).not.toBe(
          attestationId,
        );
        expect(
          (
            await db.query('SELECT attestation_event_id FROM stripe_provider_events WHERE id=$1', [
              id,
            ])
          ).rows[0],
        ).toEqual({ attestation_event_id: attestationId });
        await noAutomaticDecision([id]);
      });
    });
  },
);
