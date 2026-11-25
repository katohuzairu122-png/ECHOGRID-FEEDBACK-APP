import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { BadgeDefinitionService } from '../../src/tentaship-badges/badge-definition.service';
import { BadgeAwardService } from '../../src/tentaship-badges/badge-award.service';
import { hashSpec, parseQualificationSpec } from '../../src/qualification/qualification-spec';

/**
 * Tentaship Badges x shared qualification engine against real PostgreSQL: a badge can exist, activate and award ONLY while an approved rule version
 * exists; evidence is consumed once; replay and concurrency are safe; unapproved or retired rules fail closed; legacy points and loyalty are untouched.
 * The approved rule exists only in this disposable test database (no route approves one).
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');
const run = randomUUID();
const tag = run.replace(/[0-9-]/g, (d) => 'abcdefghijk'[d.charCodeAt(0) % 11] as string);

describe.skipIf(!databaseUrl)('Tentaship Badges qualification integration (real PostgreSQL)', () => {
  let client: Client; let repos: ReturnType<typeof createRepositories>; let defs: BadgeDefinitionService; let awards: BadgeAwardService;
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  let adminId: string; let biz: string; let seq = 0; const KEY = `badge_rule_${tag}`.slice(0, 40).toLowerCase();
  const ctx = () => ({ actorUserId: adminId });
  const customer = async () => (await repos.customers.create({ phone: `+1559${String(Date.now()).slice(-5)}${String(++seq).padStart(2, '0')}` })).id;
  const purchase = async (customerId: string, amount: string, status = 'confirmed') => {
    const m = (await q(`INSERT INTO business_customer_memberships (customer_id, business_id, status) VALUES ($1,$2,'active') ON CONFLICT DO NOTHING RETURNING id`, [customerId, biz]))[0]?.id
      ?? (await q(`SELECT id FROM business_customer_memberships WHERE customer_id = $1 AND business_id = $2`, [customerId, biz]))[0].id;
    const a = (await q(`INSERT INTO loyalty_accounts (customer_id, business_id, membership_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [customerId, biz, m]))[0]?.id
      ?? (await q(`SELECT id FROM loyalty_accounts WHERE customer_id = $1 AND business_id = $2`, [customerId, biz]))[0].id;
    return (await q(`INSERT INTO loyalty_purchase_events (business_id, customer_id, membership_id, loyalty_account_id, idempotency_key, qualifying_amount, payment_status) VALUES ($1,$2,$3,$4,$5,$6::numeric,$7) RETURNING id`, [biz, customerId, m, a, randomUUID(), amount, status]))[0].id as string;
  };
  const approveRule = async (spec: object) => {
    await q(`UPDATE qualification_rule_versions SET approval_state = 'retired', retired_at = now() WHERE rule_key = $1 AND approval_state <> 'retired'`, [KEY]);
    const parsed = parseQualificationSpec(spec);
    const v = (await q(`SELECT coalesce(max(version),0)+1 AS v FROM qualification_rule_versions WHERE rule_key = $1`, [KEY]))[0].v;
    const id = (await q(`INSERT INTO qualification_rule_versions (rule_key, version, participant_type, spec, spec_hash, created_by_user_id) VALUES ($1,$2,'customer',$3,$4,$5) RETURNING id`, [KEY, v, JSON.stringify(parsed), hashSpec(parsed), adminId]))[0].id;
    await q(`UPDATE qualification_rule_versions SET approval_state = 'approved', approved_at = now(), approved_by_user_id = $2 WHERE id = $1`, [id, adminId]);
    return id as string;
  };
  const retireRules = () => q(`UPDATE qualification_rule_versions SET approval_state = 'retired', retired_at = now() WHERE approval_state <> 'retired'`);
  const badgeBody = (key: string) => ({ key, participantType: 'customer' as const, names: { en: 'First purchase' }, descriptions: {}, rule: { metric: 'approved_qualification', threshold: 1, ruleKey: KEY } });
  let defKey = ''; let definitionId = ''; let versionId = '';

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect();
    repos = createRepositories(buildDb(client)); defs = new BadgeDefinitionService(buildDb(client)); awards = new BadgeAwardService(buildDb(client));
    adminId = (await repos.users.create({ email: `bq-${run}@example.test`, fullName: 'a', passwordHash: 'x', status: 'active' })).id;
    biz = (await repos.businesses.create({ name: `Badge Q ${tag}`, slug: `bq-${run}` })).id;
    await retireRules();
    await q(`UPDATE tentaship_badge_definition_versions SET status = 'retired', retired_at = now() WHERE status = 'active'`);
    defKey = `bq_${tag}`.slice(0, 40).toLowerCase();
  });
  afterAll(async () => {
    await retireRules().catch(() => undefined);
    await q(`UPDATE tentaship_badge_definition_versions SET status = 'retired', retired_at = now() WHERE status = 'active'`).catch(() => undefined);
    await client?.end();
  });

  it('with NO approved rule a purchase-based badge cannot be created at all (fail closed)', async () => {
    await expect(defs.createDefinition(badgeBody(defKey), ctx())).rejects.toMatchObject({ code: 'BADGE_METRIC_BLOCKED' });
    expect(await q(`SELECT 1 FROM tentaship_badge_definitions WHERE key = $1`, [defKey])).toHaveLength(0);
  });

  it('with an approved synthetic rule the badge can be created and activated; a qualifying RECORDED purchase awards it exactly once and consumes the evidence', async () => {
    await approveRule({ combinator: 'ALL', pathways: [{ metric: 'recorded_purchases', threshold: 1, minAmount: '5.00', currency: 'USD' }] });
    const created = await defs.createDefinition(badgeBody(defKey), ctx());
    definitionId = created.definition.id; versionId = created.version.id;
    await defs.activate(versionId, ctx());
    const c = await customer();
    expect(await awards.evaluate('customer', c)).toEqual([]); // no purchase yet
    await purchase(c, '4.99'); await purchase(c, '50.00', 'refunded'); await purchase(c, '50.00', 'reversed');
    expect(await awards.evaluate('customer', c)).toEqual([]); // below minimum / refunded / reversed
    const good = await purchase(c, '5.00'); // exactly the minimum
    const first = await awards.evaluate('customer', c);
    expect(first).toHaveLength(1);
    const [row] = await q(`SELECT * FROM tentaship_badge_awards WHERE customer_id = $1`, [c]);
    expect(row.evidence).toMatchObject({ metric: 'approved_qualification', qualificationRuleKey: KEY, evidenceLevel: 'recorded' });
    expect(await q(`SELECT 1 FROM qualification_evidence_consumptions WHERE evidence_id = $1 AND consumer_kind = 'badge' AND consumer_ref = $2`, [good, row.id])).toHaveLength(1);
    expect(await awards.evaluate('customer', c)).toEqual([]); // replay: nothing new
    expect(await q(`SELECT 1 FROM tentaship_badge_awards WHERE customer_id = $1`, [c])).toHaveLength(1);
  });

  it('concurrent evaluations of one customer create ONE award and ONE consumption', async () => {
    const c = await customer(); const p = await purchase(c, '9.00');
    const clients = await Promise.all(Array.from({ length: 6 }, async () => { const x = new Client({ connectionString: databaseUrl }); await x.connect(); return x; }));
    try { await Promise.all(clients.map((x) => new BadgeAwardService(buildDb(x)).evaluate('customer', c))); } finally { await Promise.all(clients.map((x) => x.end())); }
    expect(await q(`SELECT 1 FROM tentaship_badge_awards WHERE customer_id = $1`, [c])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM qualification_evidence_consumptions WHERE evidence_id = $1`, [p])).toHaveLength(1);
  });

  it('a purchase by another customer, or in another currency, never qualifies this customer', async () => {
    const a = await customer(); const b = await customer();
    await purchase(b, '500.00');
    expect(await awards.evaluate('customer', a)).toEqual([]);
    const eur = (await repos.businesses.create({ name: `Badge Q EUR ${tag}-${seq}`, slug: `bq-eur-${run}-${seq}` })).id;
    await q(`UPDATE businesses SET default_currency = 'EUR' WHERE id = $1`, [eur]);
    const m = (await q(`INSERT INTO business_customer_memberships (customer_id, business_id, status) VALUES ($1,$2,'active') RETURNING id`, [a, eur]))[0].id;
    const acc = (await q(`INSERT INTO loyalty_accounts (customer_id, business_id, membership_id) VALUES ($1,$2,$3) RETURNING id`, [a, eur, m]))[0].id;
    await q(`INSERT INTO loyalty_purchase_events (business_id, customer_id, membership_id, loyalty_account_id, idempotency_key, qualifying_amount) VALUES ($1,$2,$3,$4,$5,900)`, [eur, a, m, acc, randomUUID()]);
    expect(await awards.evaluate('customer', a)).toEqual([]);
  });

  it('retiring the approved rule fails closed: no new award; an award already made is NOT revoked automatically', async () => {
    const c = await customer(); await purchase(c, '20.00');
    const made = await awards.evaluate('customer', c);
    expect(made).toHaveLength(1);
    await retireRules();
    const d = await customer(); await purchase(d, '20.00');
    expect(await awards.evaluate('customer', d)).toEqual([]); // fail closed
    expect(await awards.listEarned('customer', c)).toHaveLength(1); // no automatic retroactive revocation
    await expect(defs.createVersion(definitionId, { names: { en: 'v2' }, descriptions: {}, rule: { metric: 'approved_qualification', threshold: 1, ruleKey: KEY } }, ctx())).rejects.toMatchObject({ code: 'BADGE_METRIC_BLOCKED' });
  });

  it('awarding a qualification badge changes no legacy points, loyalty balance or ledger', async () => {
    await approveRule({ combinator: 'ANY', pathways: [{ metric: 'recorded_purchases', threshold: 1 }] });
    const c = await customer(); await purchase(c, '1.00');
    const snap = async () => (await q(`SELECT (SELECT count(*)::int FROM community_point_transactions) AS cpt, (SELECT count(*)::int FROM loyalty_transactions) AS lt, (SELECT coalesce(sum(points),0)::int FROM loyalty_accounts) AS pts, (SELECT count(*)::int FROM loyalty_purchase_events WHERE customer_id = $1) AS pe`, [c]))[0];
    const before = await snap();
    expect((await awards.evaluate('customer', c)).length).toBeLessThanOrEqual(1);
    expect(await snap()).toEqual(before);
  });
});
