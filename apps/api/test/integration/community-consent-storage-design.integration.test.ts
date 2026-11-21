/** Current-schema characterization only. No new purpose, migration or live consent. */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(!process.env.DATABASE_URL)('NETWORK-15-T1 current consent/audit storage (disposable PG)', () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  let customerId: string;
  beforeAll(async () => {
    await client.connect();
    customerId = (await client.query<{ id: string }>("insert into customers(status) values ('active') returning id")).rows[0]!.id;
  });
  afterAll(async () => { await client.end(); });

  it('rejects an unsupported Community purpose instead of disguising it as business consent', async () => {
    await expect(client.query("insert into consent_grants(customer_id,purpose,consent_version) values ($1,'community_membership','synthetic-only')", [customerId]))
      .rejects.toMatchObject({ code: '23514' });
    expect((await client.query('select count(*)::int n from consent_grants where customer_id=$1', [customerId])).rows[0].n).toBe(0);
  });
  it('characterizes supported grants as mutable projections, not immutable acceptance evidence', async () => {
    const id = (await client.query("insert into consent_grants(customer_id,purpose,consent_version) values ($1,'survey_participation','synthetic-only') returning id", [customerId])).rows[0].id;
    await client.query("update consent_grants set status='revoked',revoked_at=now(),metadata=$2 where id=$1", [id, { fixture: 'design-characterization-only' }]);
    expect((await client.query('select status from consent_grants where id=$1', [id])).rows[0].status).toBe('revoked');
  });
  it('reuses append-only audit storage with null staff actor and refuses historical update/delete', async () => {
    const row = (await client.query("insert into audit_log(action,entity_type,entity_id,actor_user_id,metadata) values ('network15t1.design_fixture','community_membership',$1,null,$2) returning id,created_at", [randomUUID(), { customerId, synthetic: true }])).rows[0];
    await expect(client.query("update audit_log set metadata='{}' where id=$1", [row.id])).rejects.toThrow('AUDIT_LOG_IMMUTABLE');
    await expect(client.query('delete from audit_log where id=$1', [row.id])).rejects.toThrow('AUDIT_LOG_IMMUTABLE');
    expect((await client.query('select actor_user_id,metadata,created_at from audit_log where id=$1', [row.id])).rows[0])
      .toEqual({ actor_user_id: null, metadata: { customerId, synthetic: true }, created_at: row.created_at });
  });
  it('cannot treat a customer UUID as a staff audit actor', async () => {
    await expect(client.query("insert into audit_log(action,entity_type,actor_user_id) values ('network15t1.design_fixture','community_membership',$1)", [customerId]))
      .rejects.toMatchObject({ code: '23503' });
  });
  it('rolls back a design-probe membership/account when unsupported consent persistence fails', async () => {
    const id = (await client.query("insert into customers(status) values ('active') returning id")).rows[0].id;
    await client.query('begin');
    try {
      await client.query("insert into community_memberships(customer_id,status,policy_version) values ($1,'active','synthetic-probe-not-consent')", [id]);
      await client.query("insert into community_point_accounts(customer_id,status,points_balance) values ($1,'active',0)", [id]);
      await expect(client.query("insert into consent_grants(customer_id,purpose,consent_version) values ($1,'community_membership','synthetic-only')", [id]))
        .rejects.toMatchObject({ code: '23514' });
    } finally { await client.query('rollback'); }
    for (const table of ['community_memberships', 'community_point_accounts', 'consent_grants']) {
      expect((await client.query(`select count(*)::int n from ${table} where customer_id=$1`, [id])).rows[0].n).toBe(0);
    }
    expect((await client.query("select count(*)::int n from audit_log where metadata->>'customerId'=$1", [id])).rows[0].n).toBe(0);
  });
});
