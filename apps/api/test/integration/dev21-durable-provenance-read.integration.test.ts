import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { buildDb } from '../../src/db/client';
import { readRestrictedDurableProvenance } from '../../src/billing/stripe-read/restricted-durable-provenance-read';

/**
 * DEV-21: actual PostgreSQL permissions, on a disposable database with
 * disposable read-only/auditor login. No financial writers are activated.
 */
describe.skipIf(!process.env.DATABASE_URL)('DEV-21 dedicated audit reader (scratch PostgreSQL)', () => {
  const base = new URL(process.env.DATABASE_URL!);
  const suffix = randomBytes(4).toString('hex');
  const dbName = `echogrid_dev21_${suffix}`;
  const guestName = `dev21_guest_${suffix}`;
  const auditorName = `dev21_aud_${suffix}`;
  const password = randomBytes(12).toString('hex');
  const api = resolve(__dirname, '../..');
  const urlFor = (name: string, role?: string): string => {
    const u = new URL(base.toString());
    u.pathname = `/${name}`;
    if (role) { u.username = role; u.password = password; }
    return u.toString();
  };
  const clients: Client[] = [];
  let root: Client;

  beforeAll(async () => {
    root = new Client({ connectionString: urlFor('postgres') });
    await root.connect();
    await root.query(`create role ${guestName} login password '${password}'`);
    await root.query(`create role ${auditorName} login password '${password}'`);
    await root.query(`create database ${dbName}`);
    const migrated = spawnSync(process.execPath, [resolve(api, 'node_modules/drizzle-kit/bin.cjs'), 'migrate'], {
      cwd: api, encoding: 'utf8', timeout: 240_000,
      env: { ...process.env, DATABASE_URL: urlFor(dbName) },
    });
    if (migrated.status !== 0) throw new Error(`DEV21 scratch migration failed: ${(migrated.stdout + migrated.stderr).slice(-500)}`);
    await root.query(`grant settlement_auditor to ${auditorName} with inherit true, set false`);
  }, 300_000);

  afterAll(async () => {
    for (const client of clients) { try { await client.end(); } catch { /* cleanup */ } }
    try { await root.query(`drop database if exists ${dbName} with (force)`); } catch { /* cleanup */ }
    for (const name of [auditorName, guestName]) {
      try { await root.query(`drop owned by ${name}`); } catch { /* cleanup */ }
      try { await root.query(`drop role if exists ${name}`); } catch { /* cleanup */ }
    }
    try { await root.end(); } catch { /* initialization failure */ }
  });

  const request = {
    businessId: '11111111-1111-4111-8111-111111111111',
    reservationId: '22222222-2222-4222-8222-222222222222',
    authorizationId: '33333333-3333-4333-8333-333333333333',
  };

  it('ordinary login cannot query provenance through the private reader', async () => {
    const client = new Client({ connectionString: urlFor(dbName, guestName) });
    await client.connect(); clients.push(client);
    expect(await readRestrictedDurableProvenance(buildDb(client), request))
      .toEqual({ ok: false, reason: 'UNAVAILABLE' });
  });

  it('auditor membership is read-only and yields no authorization for an empty tuple', async () => {
    const client = new Client({ connectionString: urlFor(dbName, auditorName) });
    await client.connect(); clients.push(client);
    const result = await readRestrictedDurableProvenance(buildDb(client), request);
    expect(result).toEqual({ ok: true, authorization: undefined, link: undefined });
    await expect(client.query('insert into settlement_custody_authorization_links default values'))
      .rejects.toThrow();
  });

  it('auditor can read an exactly bound synthetic immutable pair without acquiring writer rights', async () => {
    // Disposable-only fabricated DB rows exercise the read contract, NOT
    // genuine custody authenticity. Full cryptographic acceptance remains
    // subject to independently issued custody evidence verification.
    const admin = new Client({ connectionString: urlFor(dbName) });
    await admin.connect(); clients.push(admin);
    const evidenceId = '55555555-5555-4555-8555-555555555555';
    const decisionId = '44444444-4444-4444-8444-444444444444';
    const hash = (ch: string) => ch.repeat(64);
    await admin.query('set session_replication_role = replica');
    try {
      await admin.query(`
        insert into partner_credit_settlement_authorizations
          (id,business_id,reservation_id,decision_id,invoice_ref,provider_account_id,
           provider_mode,allocation_digest,policy_version,verdict,reason_codes,
           classifier_version,evidence_kind,billing_interval,snapshot_ref,
           snapshot_digest,observed_at_ms,evidence_digest,provenance_version,
           signing_key_id,signature)
        values ($1,$2,$3,$4,'in_dev21','acct_dev21','test',$5,'PC-BENEFIT/1',
                'INELIGIBLE',ARRAY['NOT_SETTLED'],'v1','MOCK_SYNTHETIC',
                'month','snap_dev21',$6,500000,$7,1,'dev21',$8)
      `, [request.authorizationId, request.businessId, request.reservationId,
        decisionId, hash('a'), hash('b'), hash('c'), 'd'.repeat(128)]);
      await admin.query(`
        insert into settlement_custody_authorization_links
          (authorization_id,evidence_id,business_id,reservation_id,
           payload_sha256,custody_key_id,custody_key_version,
           authorization_evidence_digest)
        values ($1,$2,$3,$4,$5,'synthetic-dev21',1,$6)
      `, [request.authorizationId, evidenceId, request.businessId,
        request.reservationId, hash('e'), hash('c')]);
    } finally {
      await admin.query('set session_replication_role = origin');
    }
    const auditor = new Client({ connectionString: urlFor(dbName, auditorName) });
    await auditor.connect(); clients.push(auditor);
    const exact = await readRestrictedDurableProvenance(buildDb(auditor), request);
    expect(exact.ok).toBe(true);
    if (!exact.ok) throw new Error('auditor read failed closed');
    expect(exact.authorization?.id).toBe(request.authorizationId);
    expect(exact.link?.evidenceId).toBe(evidenceId);
    expect(exact.link?.authorizationEvidenceDigest).toBe(hash('c'));
    const foreign = await readRestrictedDurableProvenance(buildDb(auditor), {
      ...request, businessId: '66666666-6666-4666-8666-666666666666',
    });
    expect(foreign).toEqual({ ok: true, authorization: undefined, link: undefined });
  });

});
