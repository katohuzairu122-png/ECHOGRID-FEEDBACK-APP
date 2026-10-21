import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDb, type Database } from '../../src/db/client';
import {
  StripeEvidenceStore, ForensicReader, ForensicAccessError, loadKeyring, classifyEnvelope, cohortOf, assembleKeyring, generateKekEntry, listEventRecords,
} from '../../src/billing/stripe-evidence';

/**
 * HETA-01-F1 forensic reader (B5, C.6) against a DISPOSABLE PostgreSQL: audited, fail-closed decryption of events,
 * malformed receipts and conflict bodies; registered exports and recorded destruction.
 */
const monthsFrom = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
const testKek = (c: string) => createHash('sha256').update(`heta01-f1-test-kek:${c}`).digest().toString('base64');
const ring = () => JSON.stringify({ v: 1, keys: [0, 1, 2].map(n => { const s = monthsFrom(new Date(), n); return { cohort: cohortOf(s), kek_version: 'v1', alg: 'AES-256-GCM', key: testKek(cohortOf(s)), not_before: s.toISOString(), not_after: '2100-01-01T00:00:00Z', active: true }; }) });

describe.skipIf(!process.env.DATABASE_URL)('forensic reader (integration, disposable database)', () => {
  const clients: Client[] = [];
  let q: Client;
  const rows = async (t: string, p: unknown[] = []) => (await q.query(t, p)).rows;
  const newDb = async (): Promise<Database> => { const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); clients.push(c); return buildDb(c); };
  beforeAll(async () => { q = new Client({ connectionString: process.env.DATABASE_URL }); await q.connect(); });
  afterAll(async () => { await q.end(); await Promise.all(clients.map(c => c.end().catch(() => undefined))); });

  const dir = mkdtempSync(join(tmpdir(), 'forensic-'));
  const RETENTION = { policyVersion: 'test-v1', retainUntil: new Date(Date.now() + 86400000) };
  const SIG = { headerTimestamp: 1, scheme: 'v1' as const, secretLabel: 'p', verifiedAt: new Date(), verifierVersion: 't' };
  const CTX = { actor: 'custodian-a', reason: 'drill', approvalRef: 'CHG-7' };

  async function fixture() {
    const a = `acct_F${randomBytes(6).toString('hex')}`;
    const db = await newDb();
    const keyring = await loadKeyring(ring(), new Date());
    const store = new StripeEvidenceStore(db, { receivingAccountId: a, keyring });
    const att = (await rows(`insert into stripe_evidence_control_events(event_kind,actor,stream,details) values ('account_provenance_verified','t',$1,'{"result":"passed"}') returning id`, [`${a}:false`]))[0].id as string;
    const body = JSON.stringify({ id: `evt_f${randomBytes(6).toString('hex')}`, type: 'customer.subscription.updated', created: 1700000000, livemode: false, data: { object: { id: 'sub_f', object: 'subscription' } } });
    const shape = classifyEnvelope(body);
    if (shape.kind !== 'ok') throw new Error('fixture');
    const cap = await store.captureWellFormed({ rawBody: new TextEncoder().encode(body), envelope: shape.envelope, signature: SIG, receivedAt: new Date(), attestationEventId: att, retention: RETENTION });
    return { a, db, keyring, store, att, body, shape, eventId: cap.eventRecordId, reader: new ForensicReader(db, keyring) };
  }
  const audits = async (recordId: string) => rows(`select actor, approval_ref, details from stripe_evidence_control_events where event_kind='forensic_export_registered' and details->>'recordId'=$1 order by seq`, [recordId]);

  it('reads the exact original bytes of an event and audits the access with actor, reason and approval, never the payload', async () => {
    const f = await fixture();
    expect(new TextDecoder().decode(await f.reader.readEvent(f.eventId, CTX))).toBe(f.body);
    const a = await audits(f.eventId);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor: 'custodian-a', approval_ref: 'CHG-7', details: { mode: 'read', table: 'stripe_provider_events', recordId: f.eventId, reason: 'drill', provenance: 'webhook_signature' } });
    expect(JSON.stringify(a)).not.toContain('sub_f');
  });

  it('reads malformed receipts and conflict bodies the same way', async () => {
    const f = await fixture();
    const odd = `not json ${randomBytes(4).toString('hex')}`;
    const m = await f.store.captureMalformed({ rawBody: new TextEncoder().encode(odd), parseStatus: 'not_json', defects: ['missing_id'], signature: SIG, receivedAt: new Date(), attestationEventId: f.att, retention: RETENTION });
    expect(new TextDecoder().decode(await f.reader.readMalformed(m.receiptId, CTX))).toBe(odd);
    const altered = JSON.stringify({ ...JSON.parse(f.body), data: { object: { id: 'sub_other', object: 'subscription' } } });
    const sh = classifyEnvelope(altered);
    if (sh.kind !== 'ok') throw new Error('fixture');
    const c = await f.store.captureWellFormed({ rawBody: new TextEncoder().encode(altered), envelope: sh.envelope, signature: SIG, receivedAt: new Date(), attestationEventId: f.att, retention: RETENTION });
    expect(c.outcome).toBe('conflict');
    const conflictId = (await rows(`select id from stripe_provider_event_conflicts where event_record_id=$1`, [f.eventId]))[0].id;
    expect(new TextDecoder().decode(await f.reader.readConflict(conflictId, CTX))).toBe(altered);
    expect((await audits(conflictId))[0].details).toMatchObject({ table: 'stripe_provider_event_conflicts', conflictKind: 'webhook_digest_mismatch' });
  });

  it('refuses a bad audit context before auditing or decrypting anything', async () => {
    const f = await fixture();
    for (const bad of [{ actor: '', reason: 'x' }, { actor: 'a', reason: '   ' }, { actor: 'a', reason: 'x'.repeat(201) }]) {
      await expect(f.reader.readEvent(f.eventId, bad)).rejects.toMatchObject({ code: 'BAD_AUDIT_CONTEXT' });
    }
    expect(await audits(f.eventId)).toHaveLength(0);
  });

  it('an unknown record is NOT_FOUND', async () => {
    const f = await fixture();
    await expect(f.reader.readEvent('00000000-0000-4000-8000-000000000000', CTX)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('fails closed: if the audit row cannot be written, no plaintext is produced', async () => {
    const f = await fixture();
    const noInsert = new Proxy(f.db, { get: (t, p, r) => (p === 'insert' ? () => { throw new Error('audit store down'); } : Reflect.get(t, p, r)) });
    await expect(new ForensicReader(noInsert as Database, f.keyring).readEvent(f.eventId, CTX)).rejects.toMatchObject({ code: 'AUDIT_FAILED' });
  });

  it('a keyring that cannot unwrap the cohort fails with KEK_UNAVAILABLE and returns nothing, but the attempt is still audited', async () => {
    const f = await fixture();
    const c = (n: number) => cohortOf(monthsFrom(new Date(), n));
    const wrong = await loadKeyring(assembleKeyring([0, 1].map(n => generateKekEntry({ cohort: c(n), kekVersion: 'v1' }))), new Date());
    await expect(new ForensicReader(f.db, wrong).readEvent(f.eventId, CTX)).rejects.toBeInstanceOf(ForensicAccessError);
    expect((await audits(f.eventId)).length).toBe(1);
  });

  it('exports plaintext to a NEW 0600 file, registers the export without the path, refuses to overwrite, and records its destruction once', async () => {
    const f = await fixture();
    const path = join(dir, `export-${randomBytes(4).toString('hex')}.json`);
    const { exportLabel } = await f.reader.exportEventToFile(f.eventId, CTX, path, 'operator-laptop-A');
    expect(readFileSync(path, 'utf8')).toBe(f.body);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const reg = (await audits(f.eventId)).filter(a => a.details.mode === 'export');
    expect(reg).toHaveLength(1);
    expect(reg[0].details).toMatchObject({ exportLabel, locationLabel: 'operator-laptop-A' });
    expect(JSON.stringify(reg)).not.toContain(dir);
    await expect(f.reader.exportEventToFile(f.eventId, CTX, path, 'x')).rejects.toMatchObject({ code: 'EXPORT_EXISTS' });
    await f.reader.destroyExport(path, exportLabel, CTX);
    expect(existsSync(path)).toBe(false);
    const destroyed = await rows(`select details from stripe_evidence_control_events where event_kind='forensic_export_destroyed' and dedupe_key=$1`, [`fexd:${exportLabel}`]);
    expect(destroyed).toHaveLength(1);
    await expect(f.reader.destroyExport(path, exportLabel, CTX)).rejects.toMatchObject({ code: 'EXPORT_MISSING' });
  });

  it('destroyExport overwrites with zeros before unlinking (sanitization is best-effort; the record is what C.6 audits)', async () => {
    const f = await fixture();
    const path = join(dir, `z-${randomBytes(4).toString('hex')}.bin`);
    writeFileSync(path, 'SECRET-PLAINTEXT');
    // observe the zero-fill by hard-linking the same inode before destruction
    const { linkSync } = await import('node:fs');
    const mirror = path + '.link';
    linkSync(path, mirror);
    await f.reader.destroyExport(path, 'label-' + randomBytes(3).toString('hex'), CTX);
    expect(readFileSync(mirror).every(b => b === 0)).toBe(true);
    expect(readFileSync(mirror).length).toBe('SECRET-PLAINTEXT'.length);
  });

  it('lists evidence rows without decrypting anything', async () => {
    const f = await fixture();
    const list = await listEventRecords(f.db, f.a, f.shape.kind === 'ok' ? f.shape.envelope.id : '');
    expect(list).toEqual([{ id: f.eventId, provenance: 'webhook_signature', payloadSha256Hex: createHash('sha256').update(f.body).digest('hex') }]);
    expect(await audits(f.eventId)).toHaveLength(0);
  });
});
