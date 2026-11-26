import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { ReferralService, recordBusinessInvitationAttribution, CUSTOMER_REFERRAL_RULE_KEY } from '../../src/qualification/referral.service';
import { hashSpec, parseQualificationSpec } from '../../src/qualification/qualification-spec';

/**
 * TSH-02 / QUAL-PURCHASE-01 against real PostgreSQL: referral attribution (distinct, eligible, new, once), the database-validated lifecycle, the
 * fail-closed final qualification (no approved rule = no verified referral), purchase evidence (recorded only; refunded, reversed, earlier,
 * below-minimum and other-currency evidence excluded; exact decimals), single consumption of evidence, concurrency and append-only guards.
 * Synthetic data only; the approved rule below exists ONLY in this disposable test database.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');
const run = randomUUID();
const tag = run.replace(/[0-9-]/g, (d) => 'abcdefghijk'[d.charCodeAt(0) % 11] as string);

describe.skipIf(!databaseUrl)('TSH-02 / QUAL-PURCHASE-01 referral and purchase qualification (real PostgreSQL)', () => {
  let client: Client; let repos: ReturnType<typeof createRepositories>; let svc: ReferralService;
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  let adminId: string; let bizUsd: string; let bizEur: string; let seq = 0; let ruleVersionId = '';
  const customer = async (opts: { verified?: boolean } = {}) => {
    const id = (await repos.customers.create({ phone: `+1559${String(Date.now()).slice(-5)}${String(++seq).padStart(2, '0')}` })).id;
    if (opts.verified !== false) await q(`UPDATE customers SET phone_verified_at = now() WHERE id = $1`, [id]);
    return id;
  };
  const member = async (customerId: string, businessId: string) => {
    const m = (await q(`INSERT INTO business_customer_memberships (customer_id, business_id, status) VALUES ($1,$2,'active') RETURNING id`, [customerId, businessId]))[0].id;
    const a = (await q(`INSERT INTO loyalty_accounts (customer_id, business_id, membership_id) VALUES ($1,$2,$3) RETURNING id`, [customerId, businessId, m]))[0].id;
    return { membershipId: m as string, accountId: a as string };
  };
  const purchase = async (customerId: string, businessId: string, amount: string, over: { status?: string; at?: string } = {}) => {
    const { membershipId, accountId } = await member(customerId, businessId).catch(async () => ({
      membershipId: (await q(`SELECT id FROM business_customer_memberships WHERE customer_id = $1 AND business_id = $2`, [customerId, businessId]))[0].id as string,
      accountId: (await q(`SELECT id FROM loyalty_accounts WHERE customer_id = $1 AND business_id = $2`, [customerId, businessId]))[0].id as string,
    }));
    return (await q(`INSERT INTO loyalty_purchase_events (business_id, customer_id, membership_id, loyalty_account_id, idempotency_key, qualifying_amount, payment_status, occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6::numeric,$7, ${over.at ? '$8::timestamptz' : 'now()'}) RETURNING id`,
      over.at ? [businessId, customerId, membershipId, accountId, randomUUID(), amount, over.status ?? 'confirmed', over.at] : [businessId, customerId, membershipId, accountId, randomUUID(), amount, over.status ?? 'confirmed']))[0].id as string;
  };
  const events = (referralId: string) => q(`SELECT seq, event_type FROM customer_referral_events WHERE referral_id = $1 ORDER BY seq`, [referralId]);
  const types = async (referralId: string) => (await events(referralId)).map((e) => e.event_type as string);
  const attribute = async (referrer: string, referred: string) => (await svc.attributeCustomerReferral({ referrerCustomerId: referrer, referredCustomerId: referred, provenanceRef: randomUUID() })).referralId;
  const setRule = async (spec: object, key = CUSTOMER_REFERRAL_RULE_KEY) => {
    await q(`UPDATE qualification_rule_versions SET approval_state = 'retired', retired_at = now() WHERE rule_key = $1 AND approval_state <> 'retired'`, [key]);
    const parsed = parseQualificationSpec(spec);
    const v = ((await q(`SELECT coalesce(max(version),0)+1 AS v FROM qualification_rule_versions WHERE rule_key = $1`, [key]))[0].v) as number;
    const id = (await q(`INSERT INTO qualification_rule_versions (rule_key, version, participant_type, spec, spec_hash, created_by_user_id) VALUES ($1,$2,'customer',$3,$4,$5) RETURNING id`, [key, v, JSON.stringify(parsed), hashSpec(parsed), adminId]))[0].id;
    await q(`UPDATE qualification_rule_versions SET approval_state = 'approved', approved_at = now(), approved_by_user_id = $2 WHERE id = $1`, [id, adminId]);
    ruleVersionId = id; return id as string;
  };
  const retireAll = () => q(`UPDATE qualification_rule_versions SET approval_state = 'retired', retired_at = now() WHERE approval_state <> 'retired'`);

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect();
    repos = createRepositories(buildDb(client)); svc = new ReferralService(buildDb(client));
    adminId = (await repos.users.create({ email: `rq-${run}@example.test`, fullName: 'a', passwordHash: 'x', status: 'active' })).id;
    bizUsd = (await repos.businesses.create({ name: `Ref USD ${tag}`, slug: `rq-usd-${run}` })).id;
    bizEur = (await repos.businesses.create({ name: `Ref EUR ${tag}`, slug: `rq-eur-${run}` })).id;
    await q(`UPDATE businesses SET default_currency = 'EUR' WHERE id = $1`, [bizEur]);
    await retireAll(); // other files share this database
  });
  afterAll(async () => { await retireAll().catch(() => undefined); await client?.end(); });

  describe('attribution', () => {
    it('refuses self-referral, an ineligible referrer, a referred customer who is not new, and a second attribution', async () => {
      const a = await customer(); const b = await customer();
      await expect(svc.attributeCustomerReferral({ referrerCustomerId: a, referredCustomerId: a, provenanceRef: randomUUID() })).rejects.toMatchObject({ code: 'SELF_REFERRAL' });
      const unverified = await customer({ verified: false });
      await expect(svc.attributeCustomerReferral({ referrerCustomerId: unverified, referredCustomerId: b, provenanceRef: randomUUID() })).rejects.toMatchObject({ code: 'REFERRER_INELIGIBLE' });
      const veteran = await customer(); await purchase(veteran, bizUsd, '5.00');
      await expect(svc.attributeCustomerReferral({ referrerCustomerId: a, referredCustomerId: veteran, provenanceRef: randomUUID() })).rejects.toMatchObject({ code: 'REFERRED_NOT_NEW' });
      const member2 = await customer(); await member(member2, bizEur);
      const ok = await attribute(a, b);
      expect(await types(ok)).toEqual(['attributed']);
      await expect(svc.attributeCustomerReferral({ referrerCustomerId: a, referredCustomerId: b, provenanceRef: randomUUID() })).rejects.toMatchObject({ code: 'ALREADY_ATTRIBUTED' });
      const c = await customer();
      await expect(svc.attributeCustomerReferral({ referrerCustomerId: c, referredCustomerId: b, provenanceRef: randomUUID() })).rejects.toMatchObject({ code: 'ALREADY_ATTRIBUTED' }); // no reassignment
    });

    it('a business invitation is recorded as a BUSINESS INVITATION (never a customer referral), once per customer, with the acquisition facts', async () => {
      const c = await customer(); const ref = randomUUID();
      const tx = buildDb(client);
      expect((await recordBusinessInvitationAttribution(tx, { customerId: c, businessId: bizUsd, provenanceKind: 'owner_invitation', provenanceRef: ref })).recorded).toBe(true);
      expect((await recordBusinessInvitationAttribution(tx, { customerId: c, businessId: bizEur, provenanceKind: 'owner_invitation', provenanceRef: randomUUID() })).recorded).toBe(false);
      const [row] = await q(`SELECT * FROM customer_referrals WHERE referred_customer_id = $1`, [c]);
      expect(row).toMatchObject({ referral_type: 'business_invitation', referring_customer_id: null, business_id: bizUsd });
      expect((await q(`SELECT evidence FROM customer_referral_events WHERE referral_id = $1`, [row.id]))[0].evidence).toMatchObject({ newToPlatform: true });
    });

    it('attribution is immutable evidence: no update, delete or truncate; a referring customer cannot equal the referred one', async () => {
      const a = await customer(); const b = await customer(); const id = await attribute(a, b);
      await expect(q(`UPDATE customer_referrals SET referring_customer_id = $2 WHERE id = $1`, [id, await customer()])).rejects.toThrow(/APPEND_ONLY/);
      await expect(q(`DELETE FROM customer_referrals WHERE id = $1`, [id])).rejects.toThrow(/APPEND_ONLY/);
      await expect(q(`TRUNCATE customer_referrals`)).rejects.toThrow();
      await expect(q(`INSERT INTO customer_referrals (referral_type, referring_customer_id, referred_customer_id, provenance_kind, provenance_ref) VALUES ('customer_referral',$1,$1,'customer_referral_token',$2)`, [a, randomUUID()])).rejects.toThrow(/customer_referrals_no_self/);
    });
  });

  describe('lifecycle (database-validated)', () => {
    it('only allowed transitions; idempotent repeats; resolution of a fraud review; verified needs an approved rule', async () => {
      const a = await customer(); const b = await customer(); const id = await attribute(a, b);
      await expect(svc.advance(id, 'verified', { ruleVersionId: null })).rejects.toBeDefined(); // verified requires a rule version (check) and approval
      await svc.advance(id, 'fraud_review', { reasonCode: 'manual_review', actorUserId: adminId });
      expect((await svc.advance(id, 'fraud_review')).created).toBe(false);
      await expect(svc.advance(id, 'verified', { ruleVersionId: randomUUID() })).rejects.toBeDefined();
      await svc.advance(id, 'pending_qualification', { actorUserId: adminId });
      await svc.advance(id, 'rejected', { reasonCode: 'ineligible' });
      await expect(svc.advance(id, 'pending_qualification')).rejects.toMatchObject({ code: 'REFERRAL_TRANSITION_NOT_ALLOWED' }); // terminal
      expect(await types(id)).toEqual(['attributed', 'fraud_review', 'pending_qualification', 'rejected']);
      await expect(q(`UPDATE customer_referral_events SET event_type = 'attributed' WHERE referral_id = $1`, [id])).rejects.toThrow(/APPEND_ONLY/);
      await expect(q(`INSERT INTO customer_referral_events (referral_id, seq, event_type) VALUES ($1, 9, 'expired')`, [id])).rejects.toThrow(/SEQUENCE_GAP|TRANSITION/);
    });
  });

  describe('final qualification (fail closed)', () => {
    it('with NO approved rule nothing can be verified: the call is refused and the referral stays attributed', async () => {
      await retireAll();
      const a = await customer(); const b = await customer(); const id = await attribute(a, b);
      await purchase(b, bizUsd, '100.00');
      await expect(svc.qualify(id)).rejects.toMatchObject({ code: 'QUALIFICATION_NOT_APPROVED' });
      expect(await types(id)).toEqual(['attributed']);
      // and the database itself refuses a verified event pointing at a draft or retired rule
      const draft = (await q(`INSERT INTO qualification_rule_versions (rule_key, version, participant_type, spec, spec_hash, created_by_user_id) VALUES ('draft_probe_${tag}_${seq}', 1, 'customer', '{}', repeat('a',64), $1) RETURNING id`, [adminId]))[0].id;
      await svc.advance(id, 'pending_qualification');
      await expect(svc.advance(id, 'verified', { ruleVersionId: draft })).rejects.toMatchObject({ code: 'QUALIFICATION_NOT_APPROVED' });
    });

    it('with a synthetic APPROVED rule: verified only after a qualifying recorded purchase made AFTER attribution; evidence consumed once; idempotent', async () => {
      await setRule({ combinator: 'ALL', pathways: [{ metric: 'recorded_purchases', threshold: 1, minAmount: '10.00', currency: 'USD', sinceAttribution: true }] });
      const a = await customer(); const b = await customer();
      await purchase(b, bizUsd, '50.00', { at: '2020-01-01T00:00:00Z' }); // before attribution: excluded... but b is then not new
      const b2 = await customer(); const id = await attribute(a, b2);
      expect(await svc.qualify(id)).toMatchObject({ verified: false, reason: 'EVIDENCE_NOT_SUFFICIENT' });
      expect(await types(id)).toEqual(['attributed', 'pending_qualification']);
      // excluded evidence: below minimum, refunded, reversed, other currency, another customer's
      await purchase(b2, bizUsd, '9.99'); await purchase(b2, bizUsd, '50.00', { status: 'refunded' }); await purchase(b2, bizUsd, '50.00', { status: 'reversed' });
      await purchase(b2, bizEur, '500.00'); await purchase(a, bizUsd, '500.00');
      expect(await svc.qualify(id)).toMatchObject({ verified: false });
      const good = await purchase(b2, bizUsd, '10.00'); // exactly the minimum: included (exact decimal)
      const r = await svc.qualify(id);
      expect(r).toEqual({ verified: true });
      expect(await types(id)).toEqual(['attributed', 'pending_qualification', 'verified']);
      const ev = (await q(`SELECT evidence FROM customer_referral_events WHERE referral_id = $1 AND event_type = 'verified'`, [id]))[0].evidence;
      expect(ev).toMatchObject({ purchaseEvidenceIds: [good], evidenceLevel: 'recorded', ruleVersionId });
      expect(await q(`SELECT 1 FROM qualification_evidence_consumptions WHERE evidence_id = $1 AND consumer_ref = $2`, [good, id])).toHaveLength(1);
      expect(await svc.qualify(id)).toEqual({ verified: true }); // idempotent
      expect(await types(id)).toHaveLength(3);
      // the same evidence can never be consumed again under this rule and consumer kind
      await expect(q(`INSERT INTO qualification_evidence_consumptions (evidence_kind, evidence_id, rule_version_id, consumer_kind, consumer_ref) VALUES ('purchase_event',$1,$2,'referral','other')`, [good, ruleVersionId])).rejects.toThrow(/duplicate key/);
      void b;
    });

    it('concurrent qualification collapses to ONE verified event and one consumption', async () => {
      await setRule({ combinator: 'ANY', pathways: [{ metric: 'recorded_purchases', threshold: 1, sinceAttribution: true }] });
      const a = await customer(); const b = await customer(); const id = await attribute(a, b);
      const p = await purchase(b, bizUsd, '1.00');
      // Real concurrency needs one connection per caller (a single pg client would serialise the transactions).
      const clients = await Promise.all(Array.from({ length: 6 }, async () => { const c = new Client({ connectionString: databaseUrl }); await c.connect(); return c; }));
      let results: PromiseSettledResult<{ verified: boolean; reason?: string }>[];
      try { results = await Promise.allSettled(clients.map((c) => new ReferralService(buildDb(c)).qualify(id))); } finally { await Promise.all(clients.map((c) => c.end())); }
      expect(results.filter((x) => x.status === 'fulfilled' && x.value.verified).length).toBeGreaterThanOrEqual(1);
      expect(results.filter((x) => x.status === 'rejected')).toHaveLength(0);
      expect((await types(id)).filter((t) => t === 'verified')).toHaveLength(1);
      expect(await q(`SELECT 1 FROM qualification_evidence_consumptions WHERE evidence_id = $1`, [p])).toHaveLength(1);
    });

    it('a business invitation never qualifies as a customer referral under the default rule; it needs a rule that says so', async () => {
      await setRule({ combinator: 'ANY', pathways: [{ metric: 'referral_attributed', threshold: 1 }] });
      const c = await customer(); const tx = buildDb(client);
      await recordBusinessInvitationAttribution(tx, { customerId: c, businessId: bizUsd, provenanceKind: 'owner_invitation', provenanceRef: randomUUID() });
      const id = (await q(`SELECT id FROM customer_referrals WHERE referred_customer_id = $1`, [c]))[0].id as string;
      expect(await svc.qualify(id)).toEqual({ verified: false, reason: 'REFERRAL_TYPE_NOT_ELIGIBLE' });
      await setRule({ combinator: 'ANY', referralTypes: ['business_invitation'], pathways: [{ metric: 'referral_attributed', threshold: 1 }] });
      expect(await svc.qualify(id)).toEqual({ verified: true });
    });

    it('an ineligible (suspended) referred customer cannot qualify, and a verified referral can only be revoked by a named actor', async () => {
      await setRule({ combinator: 'ANY', pathways: [{ metric: 'recorded_purchases', threshold: 1, sinceAttribution: true }] });
      const a = await customer(); const b = await customer(); const id = await attribute(a, b); await purchase(b, bizUsd, '3.00');
      await q(`UPDATE customers SET status = 'suspended' WHERE id = $1`, [b]);
      expect(await svc.qualify(id)).toEqual({ verified: false, reason: 'CUSTOMER_NOT_ELIGIBLE' });
      await q(`UPDATE customers SET status = 'active' WHERE id = $1`, [b]);
      expect(await svc.qualify(id)).toEqual({ verified: true });
      await expect(svc.advance(id, 'revoked', { actorUserId: null })).rejects.toMatchObject({ code: 'REFERRAL_TRANSITION_NOT_ALLOWED' });
      await svc.advance(id, 'revoked', { actorUserId: adminId, reasonCode: 'issued_in_error' });
      expect((await types(id)).at(-1)).toBe('revoked');
    });
  });

  describe('rule versions', () => {
    it('content is immutable; approval is the only forward move; one approved version per key; nothing is deleted', async () => {
      const key = `rule_probe_${tag}`.slice(0, 40).toLowerCase();
      const spec = parseQualificationSpec({ combinator: 'ANY', pathways: [{ metric: 'recorded_purchases', threshold: 1 }] });
      const mk = async (v: number) => (await q(`INSERT INTO qualification_rule_versions (rule_key, version, participant_type, spec, spec_hash, created_by_user_id) VALUES ($1,$2,'customer',$3,$4,$5) RETURNING id`, [key, v, JSON.stringify(spec), hashSpec(spec), adminId]))[0].id as string;
      const v1 = await mk(1); const v2 = await mk(2);
      await expect(q(`UPDATE qualification_rule_versions SET spec = '{}' WHERE id = $1`, [v1])).rejects.toThrow(/IMMUTABLE/);
      await expect(q(`UPDATE qualification_rule_versions SET approval_state = 'approved' WHERE id = $1`, [v1])).rejects.toThrow(/approval_shape/); // approval must stamp who and when
      await q(`UPDATE qualification_rule_versions SET approval_state = 'approved', approved_at = now(), approved_by_user_id = $2 WHERE id = $1`, [v1, adminId]);
      await expect(q(`UPDATE qualification_rule_versions SET approval_state = 'approved', approved_at = now(), approved_by_user_id = $2 WHERE id = $1`, [v2, adminId])).rejects.toThrow(/one_approved/);
      await expect(q(`UPDATE qualification_rule_versions SET approval_state = 'draft', approved_at = NULL, approved_by_user_id = NULL WHERE id = $1`, [v1])).rejects.toThrow(/IMMUTABLE/);
      await expect(q(`DELETE FROM qualification_rule_versions WHERE id = $1`, [v1])).rejects.toThrow(/IMMUTABLE/);
      await expect(q(`TRUNCATE qualification_rule_versions`)).rejects.toThrow();
    });
  });
});
