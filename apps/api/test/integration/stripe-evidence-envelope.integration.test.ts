import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWrappedDek,
  openPayload,
  sealPayload,
  unwrapDek,
} from '../../src/billing/stripe-evidence/envelope';

/** Storage compatibility only, using synthetic evidence in the disposable integration tier. */
describe.skipIf(!process.env.DATABASE_URL)(
  'Standalone envelope compatibility with unchanged 0045 (real Postgres)',
  () => {
    let db: Client;
    beforeAll(async () => {
      db = new Client({ connectionString: process.env.DATABASE_URL });
      await db.connect();
    });
    afterAll(async () => {
      if (db) await db.end();
    });
    it('stores wrapped key/envelope bytes, authenticates after read-back, and rolls back all fixtures', async () => {
      const cohort = '2099-01';
      const version = `synthetic-${randomUUID()}`;
      const binding = {
        table: 'stripe_provider_events',
        identity: `synthetic-record-${randomUUID()}`,
        cohort,
        kekVersion: version,
      };
      const body = new TextEncoder().encode('synthetic encrypted storage compatibility fixture');
      const kek = (await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ])) as CryptoKey;
      const { wrapped, dek } = await createWrappedDek(kek, cohort, version);
      const sealed = await sealPayload(dek, body, binding);
      let eventId: string | undefined;
      let attestationId: string | undefined;
      await db.query('BEGIN');
      try {
        await db.query("SET LOCAL statement_timeout='10s'");
        await db.query("SET LOCAL lock_timeout='2s'");
        attestationId = (
          await db.query<{ id: string }>(`INSERT INTO stripe_evidence_control_events
        (event_kind,actor,details) VALUES ('account_provenance_verified','synthetic-envelope-test','{"result":"passed"}') RETURNING id`)
        ).rows[0]!.id;
        await db.query(
          `INSERT INTO stripe_evidence_keys
        (cohort,kek_version,wrapped_dek,wrap_nonce,wrap_algorithm,dek_fingerprint)
        VALUES ($1,$2,$3,$4,'AES-256-GCM',$5)`,
          [cohort, version, wrapped.wrappedDek, wrapped.wrapNonce, wrapped.dekFingerprint],
        );
        eventId = (
          await db.query<{ id: string }>(
            `INSERT INTO stripe_provider_events
        (receiving_account_id,event_account_id,account_scope,livemode,stripe_event_id,provenance,attestation_event_id,
         event_type,provider_created_unix,provider_created_at,received_at,payload_sha256,payload_ciphertext,payload_nonce,
         payload_key_cohort,kek_version,payload_bytes,sig_header_timestamp,sig_scheme,signing_secret_label,verified_at,
         verifier_version,capture_mode,projection_mode,retention_policy_version,retain_until)
        VALUES ('acct_syntheticFixture','acct_syntheticFixture','direct',false,$1,'webhook_signature',$2,
         'synthetic.envelope',1,to_timestamp(1),now(),$3,$4,$5,$6,$7,$8,1,'v1','fixture-only',now(),
         'fixture-only','enforced','legacy','fixture-only',now()+interval '1 day') RETURNING id`,
            [
              `evt_${randomUUID().replaceAll('-', '')}`,
              attestationId,
              sealed.payloadSha256,
              sealed.ciphertext,
              sealed.nonce,
              cohort,
              version,
              sealed.payloadBytes,
            ],
          )
        ).rows[0]!.id;
        const stored = (
          await db.query<{
            payload_ciphertext: Uint8Array;
            payload_nonce: Uint8Array;
            payload_sha256: Uint8Array;
            wrapped_dek: Uint8Array;
            wrap_nonce: Uint8Array;
            dek_fingerprint: Uint8Array;
          }>(
            `SELECT e.payload_ciphertext,e.payload_nonce,e.payload_sha256,k.wrapped_dek,k.wrap_nonce,k.dek_fingerprint
        FROM stripe_provider_events e JOIN stripe_evidence_keys k
        ON k.cohort=e.payload_key_cohort AND k.kek_version=e.kek_version WHERE e.id=$1`,
            [eventId],
          )
        ).rows[0]!;
        const restored = await unwrapDek(
          kek,
          {
            wrappedDek: stored.wrapped_dek,
            wrapNonce: stored.wrap_nonce,
            dekFingerprint: stored.dek_fingerprint,
          },
          cohort,
          version,
        );
        expect(
          await openPayload(
            restored,
            {
              ciphertext: stored.payload_ciphertext,
              nonce: stored.payload_nonce,
              payloadSha256: stored.payload_sha256,
            },
            binding,
          ),
        ).toEqual(body);
        expect(
          (
            await db.query(
              'SELECT id FROM stripe_provider_event_conflicts WHERE event_record_id=$1',
              [eventId],
            )
          ).rowCount,
        ).toBe(0);
      } finally {
        await db.query('ROLLBACK');
      }
      expect(
        (await db.query('SELECT id FROM stripe_provider_events WHERE id=$1', [eventId])).rowCount,
      ).toBe(0);
      expect(
        (await db.query('SELECT id FROM stripe_evidence_keys WHERE kek_version=$1', [version]))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await db.query('SELECT id FROM stripe_evidence_control_events WHERE id=$1', [
            attestationId,
          ])
        ).rowCount,
      ).toBe(0);
    });
  },
);
