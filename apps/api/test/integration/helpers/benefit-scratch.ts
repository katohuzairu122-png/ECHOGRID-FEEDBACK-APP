import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { buildDb } from '../../../src/db/client';
import { BenefitApplicationSagaService } from '../../../src/billing/benefit-application.saga.service';

/**
 * Scratch database for the Split 08 saga integration tests: created on the disposable server named by DATABASE_URL, migrated with the real journal,
 * fixture parents forged on one connection with FKs and the 0041/0042 write denials disabled (no real consumption path exists), dropped afterwards.
 * Disposable databases only; nothing here touches production, Neon or Stripe.
 */
export async function createBenefitScratch(prefix: string) {
  const base = new URL(process.env.DATABASE_URL!);
  const api = resolve(__dirname, '../../..');
  const dbName = `${prefix}_${randomBytes(4).toString('hex')}`;
  const urlFor = (name: string) => { const u = new URL(base.toString()); u.pathname = `/${name}`; return u.toString(); };
  const clients: Client[] = [];
  const root = new Client({ connectionString: urlFor('postgres') });
  await root.connect();
  await root.query(`create database ${dbName}`);
  await root.end();
  const m = spawnSync('pnpm', ['exec', 'drizzle-kit', 'migrate'], { cwd: api, encoding: 'utf8', timeout: 240_000, env: { ...process.env, DATABASE_URL: urlFor(dbName) } });
  if (m.status !== 0) throw new Error('scratch migrate failed');
  const connect = async () => { const c = new Client({ connectionString: urlFor(dbName) }); await c.connect(); clients.push(c); return c; };
  const admin = await connect();
  const fx = await connect();
  for (const [t, g] of [['partner_credit_award_decisions', 'partner_credit_awards_insert_disabled'], ['partner_credit_lots', 'partner_credit_lots_inert_guard'], ['partner_credit_accounts', 'partner_credit_accounts_inert_guard'], ['partner_credit_reservations', 'partner_credit_reservations_inert_guard']])
    await admin.query(`ALTER TABLE ${t} DISABLE TRIGGER ${g}`);
  await fx.query('SET session_replication_role = replica');
  const rows = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  const tenantA = (await rows<{ id: string }>("insert into businesses(name,slug,status) values('S08 A',$1,'active') returning id", [`s08-a-${dbName}`]))[0]!.id;
  const tenantB = (await rows<{ id: string }>("insert into businesses(name,slug,status) values('S08 B',$1,'active') returning id", [`s08-b-${dbName}`]))[0]!.id;
  let seq = 0;
  const makeReservation = async (businessId: string) => {
    const n = ++seq;
    const account = (await fx.query<{ id: string }>('insert into partner_credit_accounts(business_id) values($1) on conflict (business_id) do update set business_id=excluded.business_id returning id', [businessId])).rows[0]!.id;
    const decision = (await fx.query<{ id: string }>(
      `insert into partner_credit_award_decisions(settlement_ref,business_id,policy_id,state,award_units,earning_month_utc,fulfilled_at,vest_at,idempotency_key)
       values(gen_random_uuid(),$1,gen_random_uuid(),'vested',1,'2026-10',now(),now(),$2) returning id`, [businessId, `fx-${dbName}-${n}`])).rows[0]!.id;
    const lot = (await fx.query<{ id: string }>(`insert into partner_credit_lots(decision_id,account_id,units,available_units,status,vest_at,expires_at) values($1,$2,1,0,'reserved',now(),now()+interval '1 year') returning id`, [decision, account])).rows[0]!.id;
    return (await fx.query<{ id: string }>(
      `insert into partner_credit_reservations(business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at) values($1,$2,$3,$4,$5,$6,now()+interval '1 day') returning id`,
      [businessId, decision, lot, account, `intent-${n}`, `res-${dbName}-${n}`])).rows[0]!.id;
  };
  const newService = async () => new BenefitApplicationSagaService(buildDb(await connect()));
  return {
    dbName, urlFor, admin, rows, tenantA, tenantB, makeReservation, newService, connect,
    disableSagaGuards: async () => {
      for (const t of ['benefit_application_intents', 'benefit_provider_attempts', 'benefit_provider_observations', 'benefit_application_compensations', 'benefit_application_transitions', 'benefit_reconciliation_attempts'])
        await admin.query(`ALTER TABLE ${t} DISABLE TRIGGER ${t}_inert_guard`);
    },
    close: async () => {
      for (const c of clients) await c.end().catch(() => undefined);
      const a = new Client({ connectionString: urlFor('postgres') });
      await a.connect();
      await a.query(`drop database if exists ${dbName} with (force)`);
      await a.end();
    },
  };
}
