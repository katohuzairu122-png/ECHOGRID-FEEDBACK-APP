import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { OrphanQualificationService } from '../../src/orphan-settlement/orphan-qualification.service';
import { CustomerOrphanAccessService } from '../../src/orphan-settlement/customer-orphan-access.service';
import { ReceivingBusinessSettlementService, ORPHAN_SETTLEMENT_FULFILLMENT_POLICY_VERSION } from '../../src/orphan-settlement/receiving-business-settlement.service';
import { CustomerSettlementCompletionService } from '../../src/orphan-settlement/customer-settlement-completion.service';
import { OrphanSettlementFulfillmentService } from '../../src/orphan-settlement/orphan-settlement-fulfillment.service';
import { OrphanSettlementReversalService } from '../../src/orphan-settlement/orphan-settlement-reversal.service';
import { PartnerProvisionalAwardService } from '../../src/partner-credits/partner-provisional-award.service';
import { PartnerCreditProjectionAudit } from '../../src/partner-credits/partner-credit-projection.audit';
import { PartnerCreditLifecycleService } from '../../src/partner-credits/partner-credit-lifecycle.service';
import { PartnerCreditReservationService } from '../../src/partner-credits/partner-credit-reservation.service';
import { PartnerCreditTerminalEvidenceReader } from '../../src/billing/partner-credit-terminal-evidence.reader';
import { Split08Ce1TenantIntegrityVerifier } from '../../src/billing/ce1-tenant-integrity.verifier';
import type { OrphanSettlementCompletionEvidence } from '@echo-grid-feedback/shared-types';

/**
 * EXPLICIT ISOLATION REQUIRED: this test intentionally disables 0041 triggers
 * on a disposable database, NEVER on the normal DATABASE_URL. Provision and
 * migrate a separate database before setting PARTNER_AWARD_TEST_DATABASE_URL.
 * The triggers are restored even when an assertion fails. Do not use production.
 */
const url = process.env.PARTNER_AWARD_TEST_DATABASE_URL;
describe.skipIf(!url)('Split 07 positive/concurrent provisional awards — isolated PostgreSQL', () => {
  let admin: Client;
  let originId: string;
  let receiverId: string;
  let branchIds: string[];
  let actorId: string;
  let platformAdminId: string;
  let accountId: string;
  const clients: Client[] = [];
  const triggers = [
    ['partner_credit_award_decisions','partner_credit_awards_insert_disabled'],
    ['partner_credit_ledger','partner_credit_ledger_insert_disabled'],
    ['partner_credit_lots','partner_credit_lots_inert_guard'],
    ['partner_credit_accounts','partner_credit_accounts_inert_guard'],
    ['partner_credit_recovery_obligations','partner_credit_recovery_insert_disabled'],
  ] as const;

  async function query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    return admin.query<T>(sql, params);
  }
  async function newDb() {
    const client = new Client({connectionString:url});
    await client.connect();
    clients.push(client);
    return buildDb(client);
  }
  async function fixture(branchId: string): Promise<OrphanSettlementCompletionEvidence> {
    const db = await newDb();
    const repos = createRepositories(db);
    const suffix = crypto.randomUUID();
    const customer = await repos.customers.create({
      phone: '+1595' + String(Math.floor(Math.random()*9_000_000+1_000_000)),
      phoneVerifiedAt: new Date(),
    });
    const member = await repos.customerMemberships.create({
      customerId:customer.id, businessId:originId, status:'business_exited',
      onboardingSource:'split07-isolated-award-test',
    });
    const account = await repos.loyaltyAccounts.create({
      customerId:customer.id,businessId:originId,membershipId:member.id,points:90,
    });
    const reward = await repos.loyaltyRewards.create({
      businessId:originId,name:'Award test reward '+suffix,type:'voucher',
      rewardValue:'20.00',status:'active',
    });
    const redemption = await repos.loyaltyTransactions.create({
      loyaltyAccountId:account.id,type:'redemption',points:-20,
      relatedRewardId:reward.id,redemptionCode:'S07-'+suffix,issuanceStatus:'issued',
    });
    const qualified = await new OrphanQualificationService(db).qualify({
      sourceTransactionId:redemption.id,customerId:customer.id,
      originBusinessId:originId,orphanReason:'origin_business_archived',
    });
    const proposal = await new CustomerOrphanAccessService(db).authorizeAccess(
      customer.id,qualified.claim.id,{
        receivingBusinessId:receiverId,consentVersion:'settlement-v1',
        correlationId:'s07-access-'+suffix,idempotencyKey:'s07-proposal-'+suffix,
      },
    );
    const reference='s07-fulfillment-'+suffix;
    const accepted = await new ReceivingBusinessSettlementService(db).acceptAndReserve({
      businessId:receiverId,branchId,actorUserId:actorId,
      settlementId:proposal.settlement.id,
      acceptance:{authorizationId:proposal.authorization.id,fulfillment:{
        benefitType:'voucher',title:'Award test replacement voucher',
        description:'Replacement for verified settlement',reference,
      }},
    });
    await new CustomerSettlementCompletionService(db).authorizeCompletion(
      customer.id,accepted.settlement.id,{
        correlationId:'s07-completion-'+suffix,idempotencyKey:'s07-complete-'+suffix,
        fulfillmentPolicyVersion:ORPHAN_SETTLEMENT_FULFILLMENT_POLICY_VERSION,
        fulfillmentReference:reference,
      },
    );
    const fulfilled = await new OrphanSettlementFulfillmentService(db).fulfill({
      businessId:receiverId,branchId,actorUserId:actorId,
      settlementId:accepted.settlement.id,
    });
    return fulfilled.evidence;
  }

  beforeAll(async () => {
    if (!url || url === process.env.DATABASE_URL || /prod(uction)?/i.test(url))
      throw new Error('PARTNER_AWARD_TEST_DATABASE_URL must be a separate disposable nonproduction PostgreSQL database');
    admin = new Client({connectionString:url});
    await admin.connect();
    const tag=crypto.randomUUID();
    // All ordinary integration suites use DATABASE_URL; this one must be isolated.
    const origin = await query<{id:string}>('INSERT INTO businesses(name,slug,status) VALUES($1,$2,$3) RETURNING id',
      ['Split 07 concurrency origin','s07-atomic-origin-'+tag,'archived']);
    originId=origin.rows[0]!.id;
    const receiver = await query<{id:string}>('INSERT INTO businesses(name,slug,status) VALUES($1,$2,$3) RETURNING id',
      ['Split 07 concurrency receiver','s07-atomic-receiver-'+tag,'active']);
    receiverId=receiver.rows[0]!.id;
    const user = await query<{id:string}>('INSERT INTO users(email,password_hash,full_name,status) VALUES($1,$2,$3,$4) RETURNING id',
      ['s07-award-'+tag+'@example.test','not-used','Award Test Staff','active']);
    actorId=user.rows[0]!.id;
    const adminUser = await query<{id:string}>('INSERT INTO users(email,password_hash,full_name,status,platform_role) VALUES($1,$2,$3,$4,$5) RETURNING id',
      ['s07-award-admin-'+tag+'@example.test','not-used','Award Test Admin','active','admin']);
    platformAdminId=adminUser.rows[0]!.id;
    const branches=await Promise.all(['a','b'].map(async letter=>(await query<{id:string}>(
      'INSERT INTO branches(business_id,name,slug) VALUES($1,$2,$3) RETURNING id',
      [receiverId,'Award Test Branch '+letter,'s07-'+letter+'-'+tag])).rows[0]!.id));
    branchIds=branches;
    const policy=await query<{id:string}>(
      "INSERT INTO partner_credit_policies(version,state,effective_at) VALUES($1,'active',$2) RETURNING id",
      ['PC-ECON/1',new Date(Date.now()-86400_000)]);
    expect(policy.rows).toHaveLength(1);
    await query(
      "INSERT INTO partner_program_enrollments(business_id,status,policy_version,accepted_by_user_id,accepted_at,effective_at) VALUES($1,'active',$2,$3,$4,$4)",
      [receiverId,'PC-ECON/1',actorId,new Date(Date.now()-3600_000)],
    );
    // Dedicated disposable DB only: enable positive economic path for this test.
    for(const [table,trigger] of triggers)
      await query('ALTER TABLE '+table+' DISABLE TRIGGER '+trigger);
  }, 120000);

  afterAll(async () => {
    if (admin) {
      for(const [table,trigger] of triggers)
        await query('ALTER TABLE '+table+' ENABLE TRIGGER '+trigger);
    }
    await Promise.all(clients.map(c=>c.end()));
    if (admin) await admin.end();
  }, 120000);

  it('awards one provisional noncash unit and exact replay without duplicate history', async () => {
    const evidence=await fixture(branchIds[0]!);
    const db=await newDb();
    const service=new PartnerProvisionalAwardService(db);
    const first=await service.decide(evidence);
    expect(first).toMatchObject({state:'provisional',units:1,replay:false});
    expect(await service.decide(evidence)).toMatchObject({state:'provisional',units:1,replay:true,decisionId:first.decisionId});
    const rows=await query<{decisions:string,lots:string,ledger:string,provisional:string,available:string}>(`
      SELECT (SELECT count(*)::text FROM partner_credit_award_decisions WHERE settlement_ref=$1) AS decisions,
       (SELECT count(*)::text FROM partner_credit_lots l JOIN partner_credit_award_decisions d ON d.id=l.decision_id WHERE d.settlement_ref=$1) AS lots,
       (SELECT count(*)::text FROM partner_credit_ledger l JOIN partner_credit_award_decisions d ON d.id=l.decision_id WHERE d.settlement_ref=$1) AS ledger,
       (SELECT provisional::text FROM partner_credit_accounts WHERE business_id=$2) AS provisional,
       (SELECT available::text FROM partner_credit_accounts WHERE business_id=$2) AS available
    `,[evidence.settlementRef,receiverId]);
    expect(rows.rows[0]).toMatchObject({decisions:'1',lots:'1',ledger:'1',provisional:'1',available:'0'});
  }, 120000);

  it('rolls back decision and lot when the ledger idempotency insert conflicts', async () => {
    const evidence=await fixture(branchIds[0]!);
    const account=await query<{id:string}>(
      'SELECT id FROM partner_credit_accounts WHERE business_id=$1',[receiverId]);
    accountId=account.rows[0]!.id;
    const key='partner-provisional:v1:'+evidence.settlementRef;
    await query(
      "INSERT INTO partner_credit_ledger(account_id,entry_type,units,idempotency_key) VALUES($1,'provisional',1,$2)",
      [accountId,key]);
    const db=await newDb();
    await expect(new PartnerProvisionalAwardService(db).decide(evidence)).rejects.toBeDefined();
    const state=await query<{decisions:string,lots:string}>(
      `SELECT (SELECT count(*)::text FROM partner_credit_award_decisions WHERE settlement_ref=$1) decisions,
        (SELECT count(*)::text FROM partner_credit_lots l JOIN partner_credit_award_decisions d ON d.id=l.decision_id WHERE d.settlement_ref=$1) lots`,
      [evidence.settlementRef]);
    expect(state.rows[0]).toMatchObject({decisions:'0',lots:'0'});
  }, 120000);


  it('enforces ten successful awards across eleven concurrent settlements and two branches', async () => {
    const evidence=await Promise.all(Array.from({length:11},(_,i)=>fixture(branchIds[i%2]!)));
    const results=await Promise.all(evidence.map(async row=>
      new PartnerProvisionalAwardService(await newDb()).decide(row)));
    expect(results.filter(r=>r.state==='provisional')).toHaveLength(9);
    expect(results.filter(r=>r.state==='cap_exceeded')).toHaveLength(2);
    const summary=await query<{awarded:string,provisional:string,available:string}>(
      `SELECT
       (SELECT coalesce(sum(award_units),0)::text FROM partner_credit_award_decisions WHERE business_id=$1) awarded,
       (SELECT provisional::text FROM partner_credit_accounts WHERE business_id=$1) provisional,
       (SELECT available::text FROM partner_credit_accounts WHERE business_id=$1) available`,[receiverId]);
    expect(summary.rows[0]).toMatchObject({awarded:'10',provisional:'10',available:'0'});
  }, 180000);


  it('enforces CE-1 persistence: one reservation per lot, invoice, application and provider reference', async () => {
    await resetReceivingBusinessForReversalTests();
    await query('ALTER TABLE partner_credit_reservations DISABLE TRIGGER partner_credit_reservations_inert_guard');
    await query('ALTER TABLE billing_partner_credit_applications DISABLE TRIGGER billing_partner_credit_applications_inert_guard');
    try {
    const evidence=await fixture(branchIds[0]!);
    const db=await newDb();
    const award=await new PartnerProvisionalAwardService(db).decide(evidence);
    expect(award.state).toBe('provisional');
    const lot=(await query<{lot_id:string;account_id:string}>(`
      SELECT id AS lot_id,account_id FROM partner_credit_lots WHERE decision_id=$1`,
      [award.decisionId])).rows[0]!;
    const key=crypto.randomUUID();
    const reservation=(await query<{id:string}>(`
      INSERT INTO partner_credit_reservations
      (business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [receiverId,award.decisionId,lot.lot_id,lot.account_id,'ce1-intent-'+key,'ce1-key-'+key,
        new Date(Date.now()+86400_000)])).rows[0]!;
    await expect(query(`
      INSERT INTO partner_credit_reservations
      (business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [receiverId,award.decisionId,lot.lot_id,lot.account_id,'ce1-intent-other-'+key,'ce1-key-other-'+key,
        new Date(Date.now()+86400_000)])).rejects.toMatchObject({code:'23505'});
    const plan=(await query<{id:string}>(`
      INSERT INTO subscription_plans(key,name,price_monthly_cents)
      VALUES ($1,$2,0) RETURNING id`,['ce1-plan-'+key,'CE1 isolated test plan'])).rows[0]!;
    const subscription=(await query<{id:string}>(`
      INSERT INTO business_subscriptions(business_id,plan_id,status,billing_interval)
      VALUES ($1,$2,'active','month') RETURNING id`,
      [receiverId,plan.id])).rows[0]!;
    const params=[reservation.id,receiverId,subscription.id,'ce1-invoice-'+key,
      'ce1-provider-'+key,'ce1-apply-'+key];
    const application=(await query<{id:string}>(`
      INSERT INTO billing_partner_credit_applications
      (reservation_id,business_id,subscription_id,invoice_ref,provider_success_ref,idempotency_key,units_applied,terminal_state,applied_at)
      VALUES ($1,$2,$3,$4,$5,$6,1,'applied',now()) RETURNING id`,params)).rows[0]!;
    expect(application.id).toBeTruthy();
    await expect(query(`
      INSERT INTO billing_partner_credit_applications
      (reservation_id,business_id,subscription_id,invoice_ref,provider_success_ref,idempotency_key,units_applied,terminal_state,applied_at)
      VALUES ($1,$2,$3,$4,$5,$6,1,'applied',now())`,
      [reservation.id,receiverId,subscription.id,'another-invoice-'+key,'another-provider-'+key,'another-key-'+key]
    )).rejects.toMatchObject({code:'23505'});
    await expect(query(`INSERT INTO billing_partner_credit_applications
      (reservation_id,business_id,subscription_id,invoice_ref,provider_success_ref,idempotency_key,units_applied,terminal_state,applied_at)
      VALUES ($1,$2,$3,$4,$5,$6,2,'applied',now())`,
      [crypto.randomUUID(),receiverId,subscription.id,'invalid-'+key,'p-invalid-'+key,'key-invalid-'+key]
    )).rejects.toMatchObject({code:'23514'});
    // Schema is deliberately inert: a synthetic "applied" row is NOT
    // external payment proof, and must not mutate Partner Credit balances.
    const account=(await query<{provisional:string;available:string;reserved:string}>(`
      SELECT provisional::text,available::text,reserved::text
      FROM partner_credit_accounts WHERE id=$1`,[lot.account_id])).rows[0]!;
    expect(account).toMatchObject({provisional:'1',available:'0',reserved:'0'});
    } finally {
      await query('ALTER TABLE billing_partner_credit_applications ENABLE TRIGGER billing_partner_credit_applications_inert_guard');
      await query('ALTER TABLE partner_credit_reservations ENABLE TRIGGER partner_credit_reservations_inert_guard');
    }
  },120000);


  async function resetReceivingBusinessForReversalTests() {
    const tag=crypto.randomUUID();
    const result=await query<{id:string}>(
      'INSERT INTO businesses(name,slug,status) VALUES($1,$2,$3) RETURNING id',
      ['Split 07 reversal cohort','s07-reversal-'+tag,'active']);
    receiverId=result.rows[0]!.id;
    branchIds=await Promise.all(['a','b'].map(async letter=>(await query<{id:string}>(
      'INSERT INTO branches(business_id,name,slug) VALUES($1,$2,$3) RETURNING id',
      [receiverId,'Reversal Cohort Branch '+letter,'s07-reversal-'+letter+'-'+tag]
    )).rows[0]!.id));
    await query(
      "INSERT INTO partner_program_enrollments(business_id,status,policy_version,accepted_by_user_id,accepted_at,effective_at) VALUES($1,'active',$2,$3,$4,$4)",
      [receiverId,'PC-ECON/1',actorId,new Date(Date.now()-3600_000)],
    );
  }

  it('rejects cross-business CE-1 application and never treats stored reference as provider verification', async () => {
    await resetReceivingBusinessForReversalTests();
    const evidence=await fixture(branchIds[0]!);
    const db=await newDb();
    const awarded=await new PartnerProvisionalAwardService(db).decide(evidence);
    expect(awarded.state).toBe('provisional');
    const lot=(await query<{id:string;account_id:string}>(
      'SELECT id,account_id FROM partner_credit_lots WHERE decision_id=$1',
      [awarded.decisionId])).rows[0]!;
    await query("UPDATE partner_credit_award_decisions SET state='vested' WHERE id=$1",[awarded.decisionId]);
    await query("UPDATE partner_credit_lots SET status='consumed',available_units=0 WHERE id=$1",[lot.id]);
    await query("UPDATE partner_credit_accounts SET provisional=provisional-1 WHERE id=$1",[lot.account_id]);
    const tag=crypto.randomUUID();
    const other=(await query<{id:string}>(
      "INSERT INTO businesses(name,slug,status) VALUES('CE1 forged tenant',$1,'active') RETURNING id",
      ['ce1-cross-tenant-'+tag])).rows[0]!;
    const plan=(await query<{id:string}>(
      "INSERT INTO subscription_plans(key,name,price_monthly_cents) VALUES($1,'CE1 test',0) RETURNING id",
      ['ce1-plan-'+tag])).rows[0]!;
    const subscription=(await query<{id:string}>(
      "INSERT INTO business_subscriptions(business_id,plan_id,status,billing_interval) VALUES($1,$2,'active','month') RETURNING id",
      [other.id,plan.id])).rows[0]!;
    await query('ALTER TABLE partner_credit_reservations DISABLE TRIGGER partner_credit_reservations_inert_guard');
    await query('ALTER TABLE billing_partner_credit_applications DISABLE TRIGGER billing_partner_credit_applications_inert_guard');
    // Since migration 0047 the database itself rejects these cross-tenant rows (see the next test). This test keeps proving the
    // read-side verifier fail-closed as defense in depth, so it must build the forged rows with foreign-key enforcement off for
    // this one disposable connection only (replica role skips FK triggers; it is reset in the finally block).
    await query('SET session_replication_role = replica');
    try {
      const reservation=(await query<{id:string}>(`INSERT INTO partner_credit_reservations
        (business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at,state,terminal_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'consumed',$8) RETURNING id`,
        [receiverId,awarded.decisionId,lot.id,lot.account_id,'intent-'+tag,'reserve-'+tag,
          new Date(Date.now()+86400_000),new Date(Date.now()+60000)])).rows[0]!;
      await query(`INSERT INTO billing_partner_credit_applications
        (reservation_id,business_id,subscription_id,invoice_ref,provider_success_ref,idempotency_key,units_applied,terminal_state,applied_at)
        VALUES($1,$2,$3,$4,$5,$6,1,'applied',now())`,
        [reservation.id,receiverId,subscription.id,'inv-'+tag,'provider-'+tag,'apply-'+tag]);
      const verifier=new Split08Ce1TenantIntegrityVerifier(db);
      await expect(verifier.inspect(reservation.id))
        .rejects.toThrow('CE1_APPLICATION_TENANT_OR_TERMINAL_MISMATCH');
      const owned=(await query<{id:string}>(
        "INSERT INTO business_subscriptions(business_id,plan_id,status,billing_interval) VALUES($1,$2,'active','month') RETURNING id",
        [receiverId,plan.id])).rows[0]!;
      await query('UPDATE billing_partner_credit_applications SET subscription_id=$1 WHERE reservation_id=$2',
        [owned.id,reservation.id]);
      const result=await verifier.inspect(reservation.id);
      expect(result).toMatchObject({
        structurallyConsistent:true,providerVerified:false,businessId:receiverId,
      });
      const foreignAccount=(await query<{id:string}>(
        'INSERT INTO partner_credit_accounts(business_id) VALUES($1) RETURNING id',
        [other.id])).rows[0]!;
      await query('UPDATE partner_credit_reservations SET account_id=$1 WHERE id=$2',
        [foreignAccount.id,reservation.id]);
      await expect(verifier.inspect(reservation.id))
        .rejects.toThrow('CE1_ACCOUNT_TENANT_MISMATCH');
      await query('UPDATE partner_credit_reservations SET account_id=$1,business_id=$2 WHERE id=$3',
        [lot.account_id,other.id,reservation.id]);
      await expect(verifier.inspect(reservation.id))
        .rejects.toThrow('CE1_SETTLEMENT_TENANT_MISMATCH');
    } finally {
      await query('RESET session_replication_role');
      await query('ALTER TABLE billing_partner_credit_applications ENABLE TRIGGER billing_partner_credit_applications_inert_guard');
      await query('ALTER TABLE partner_credit_reservations ENABLE TRIGGER partner_credit_reservations_inert_guard');
    }
  },120000);

  it('database enforces CE-1 tenant integrity (0047): cross-business reservation and application rows are refused with FK violations', async () => {
    await resetReceivingBusinessForReversalTests();
    const evidence=await fixture(branchIds[0]!);
    const awarded=await new PartnerProvisionalAwardService(await newDb()).decide(evidence);
    const lot=(await query<{id:string;account_id:string}>('SELECT id,account_id FROM partner_credit_lots WHERE decision_id=$1',[awarded.decisionId])).rows[0]!;
    const tag=crypto.randomUUID();
    const other=(await query<{id:string}>("INSERT INTO businesses(name,slug,status) VALUES('CE1 db tenant',$1,'active') RETURNING id",['ce1-db-tenant-'+tag])).rows[0]!;
    const foreignAccount=(await query<{id:string}>('INSERT INTO partner_credit_accounts(business_id) VALUES($1) RETURNING id',[other.id])).rows[0]!;
    const reserve=(args:{business:string;decision:string;lot:string;account:string}) => query(
      `INSERT INTO partner_credit_reservations(business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [args.business,args.decision,args.lot,args.account,'intent-'+crypto.randomUUID(),'reserve-'+crypto.randomUUID(),new Date(Date.now()+86400_000)]);
    await query('ALTER TABLE partner_credit_reservations DISABLE TRIGGER partner_credit_reservations_inert_guard');
    await query('ALTER TABLE billing_partner_credit_applications DISABLE TRIGGER billing_partner_credit_applications_inert_guard');
    try {
      // account belongs to another business
      await expect(reserve({business:receiverId,decision:awarded.decisionId,lot:lot.id,account:foreignAccount.id})).rejects.toMatchObject({code:'23503',constraint:expect.stringMatching(/account_business_fk|lot_decision_account_fk/)});
      // reservation claims another business than the decision's
      await expect(reserve({business:other.id,decision:awarded.decisionId,lot:lot.id,account:lot.account_id})).rejects.toMatchObject({code:'23503',constraint:'partner_credit_reservations_decision_business_fk'});
      // lot paired with a decision/account it does not belong to
      await expect(reserve({business:other.id,decision:awarded.decisionId,lot:lot.id,account:foreignAccount.id})).rejects.toMatchObject({code:'23503'});
      // the matching tuple is accepted structurally (still not provider-verified consumption), then application tenant keys are checked
      await reserve({business:receiverId,decision:awarded.decisionId,lot:lot.id,account:lot.account_id});
      const reservation=(await query<{id:string}>('SELECT id FROM partner_credit_reservations WHERE lot_id=$1',[lot.id])).rows[0]!;
      const plan=(await query<{id:string}>("INSERT INTO subscription_plans(key,name,price_monthly_cents) VALUES($1,'CE1 db test',0) RETURNING id",['ce1-db-plan-'+tag])).rows[0]!;
      const foreignSub=(await query<{id:string}>("INSERT INTO business_subscriptions(business_id,plan_id,status,billing_interval) VALUES($1,$2,'active','month') RETURNING id",[other.id,plan.id])).rows[0]!;
      const apply=(business:string,subscription:string) => query(
        `INSERT INTO billing_partner_credit_applications(reservation_id,business_id,subscription_id,invoice_ref,provider_success_ref,idempotency_key,units_applied,terminal_state,applied_at)
         VALUES($1,$2,$3,$4,$5,$6,1,'applied',now())`,
        [reservation.id,business,subscription,'inv-'+crypto.randomUUID(),'provider-'+crypto.randomUUID(),'apply-'+crypto.randomUUID()]);
      await expect(apply(receiverId,foreignSub.id)).rejects.toMatchObject({code:'23503',constraint:'billing_partner_credit_applications_subscription_business_fk'});
      await expect(apply(other.id,foreignSub.id)).rejects.toMatchObject({code:'23503',constraint:'billing_partner_credit_applications_reservation_business_fk'});
      const counts=await query<{r:string;a:string}>("SELECT (SELECT count(*) FROM partner_credit_reservations WHERE lot_id=$1)::text r,(SELECT count(*) FROM billing_partner_credit_applications WHERE reservation_id=$2)::text a",[lot.id,reservation.id]);
      expect(counts.rows[0]).toEqual({r:'1',a:'0'});
    } finally {
      await query('DELETE FROM partner_credit_reservations WHERE lot_id=$1',[lot.id]);
      await query('ALTER TABLE billing_partner_credit_applications ENABLE TRIGGER billing_partner_credit_applications_inert_guard');
      await query('ALTER TABLE partner_credit_reservations ENABLE TRIGGER partner_credit_reservations_inert_guard');
    }
  },120000);

  it('refuses early vesting and early expiration without credit mutations', async () => {
    await resetReceivingBusinessForReversalTests();
    const evidence=await fixture(branchIds[0]!);
    const db=await newDb();
    const award=await new PartnerProvisionalAwardService(db).decide(evidence);
    expect(award.state).toBe('provisional');
    const lifecycle=new PartnerCreditLifecycleService(db);
    await expect(lifecycle.vest(award.decisionId,new Date()))
      .rejects.toThrow('PARTNER_VEST_NOT_ELIGIBLE');
    await expect(lifecycle.expire(award.decisionId,new Date()))
      .rejects.toThrow('PARTNER_EXPIRY_NOT_VESTED');
    const balance=await query<{available:string;provisional:string}>(
      'SELECT available::text,provisional::text FROM partner_credit_accounts WHERE business_id=$1',
      [receiverId]);
    expect(balance.rows[0]).toMatchObject({available:'0',provisional:'1'});
  },120000);

  it('moves one due provisional unit to available and expires at UTC anniversary exactly once', async () => {
    await resetReceivingBusinessForReversalTests();
    const evidence=await fixture(branchIds[0]!);
    const db=await newDb();
    const award=await new PartnerProvisionalAwardService(db).decide(evidence);
    expect(award.state).toBe('provisional');
    const lifecycle=new PartnerCreditLifecycleService(db);
    const vestNow=new Date(Date.parse(evidence.fulfilledAt)+15*86400_000);
    expect(await lifecycle.vest(award.decisionId,vestNow)).toBe('vested');
    expect(await lifecycle.vest(award.decisionId,vestNow)).toBe('already_vested');
    const before=await query<{provisional:string;available:string;expires_at:Date}>(
      `SELECT a.provisional::text,a.available::text,l.expires_at
       FROM partner_credit_accounts a JOIN partner_credit_lots l ON l.account_id=a.id
       WHERE a.business_id=$1 AND l.decision_id=$2`,[receiverId,award.decisionId]);
    expect(before.rows[0]).toMatchObject({provisional:'0',available:'1'});
    const expiresAt=before.rows[0]!.expires_at;
    await expect(lifecycle.expire(award.decisionId,new Date(expiresAt.getTime()-1)))
      .rejects.toThrow('PARTNER_EXPIRY_NOT_ELIGIBLE');
    expect(await lifecycle.expire(award.decisionId,expiresAt)).toBe('expired');
    expect(await lifecycle.expire(award.decisionId,expiresAt)).toBe('already_expired');
    const after=await query<{provisional:string;available:string;lot_status:string;vests:string;expiries:string}>(
      `SELECT a.provisional::text,a.available::text,l.status AS lot_status,
        (SELECT count(*)::text FROM partner_credit_ledger WHERE decision_id=$2 AND entry_type='vest') AS vests,
        (SELECT count(*)::text FROM partner_credit_ledger WHERE decision_id=$2 AND entry_type='expire') AS expiries
       FROM partner_credit_accounts a JOIN partner_credit_lots l ON l.account_id=a.id
       WHERE a.business_id=$1 AND l.decision_id=$2`,[receiverId,award.decisionId]);
    expect(after.rows[0]).toMatchObject({
      provisional:'0',available:'0',lot_status:'expired',vests:'1',expiries:'1',
    });
  },120000);

  it('offsets debt before vesting availability and never double-applies a recovery', async () => {
    await resetReceivingBusinessForReversalTests();
    const evidence=await fixture(branchIds[0]!);
    const db=await newDb();
    const award=await new PartnerProvisionalAwardService(db).decide(evidence);
    expect(award.state).toBe('provisional');
    const [account]= (await query<{id:string}>(
      'SELECT id FROM partner_credit_accounts WHERE business_id=$1',[receiverId])).rows;
    // This is a synthetic obligation injected only into the isolated,
    // disposable test database. No Split 08 consumption proof exists yet.
    const reversalRef=crypto.randomUUID();
    await query(
      'INSERT INTO partner_credit_recovery_obligations(account_id,reversal_ref,units_due,units_outstanding) VALUES($1,$2,1,1)',
      [account!.id,reversalRef]);
    await query('UPDATE partner_credit_accounts SET recovery_due=1 WHERE id=$1',[account!.id]);
    const at=new Date(Date.parse(evidence.fulfilledAt)+15*86400_000);
    const service=new PartnerCreditLifecycleService(db);
    expect(await service.vest(award.decisionId,at)).toBe('vested');
    expect(await service.vest(award.decisionId,at)).toBe('already_vested');
    const result=await query<{
      provisional:string;available:string;due:string;lot_status:string;
      outstanding:string;offset_entries:string;vest_entries:string;
    }>(`SELECT a.provisional::text,a.available::text,a.recovery_due::text AS due,
        l.status AS lot_status,
        (SELECT units_outstanding::text FROM partner_credit_recovery_obligations WHERE reversal_ref=$3) AS outstanding,
        (SELECT count(*)::text FROM partner_credit_ledger WHERE decision_id=$2 AND entry_type='recovery_offset') AS offset_entries,
        (SELECT count(*)::text FROM partner_credit_ledger WHERE decision_id=$2 AND entry_type='vest') AS vest_entries
      FROM partner_credit_accounts a JOIN partner_credit_lots l ON l.account_id=a.id
      WHERE a.business_id=$1 AND l.decision_id=$2`,[receiverId,award.decisionId,reversalRef]);
    expect(result.rows[0]).toMatchObject({
      provisional:'0',available:'0',due:'0',lot_status:'consumed',
      outstanding:'0',offset_entries:'1',vest_entries:'1',
    });
  },120000);

  it('atomically compensates a prior provisional award when Split 06 reverses settlement', async () => {
    await resetReceivingBusinessForReversalTests();
    const evidence=await fixture(branchIds[0]!);
    const db=await newDb();
    const awarded=await new PartnerProvisionalAwardService(db).decide(evidence);
    expect(awarded.state).toBe('provisional');
    const result=await new OrphanSettlementReversalService(db).reverse(evidence.settlementRef,{
      reasonCode:'verified-fraud', evidenceReference:'s07-prior-award-'+crypto.randomUUID(),
      idempotencyKey:'s07-compensate-'+crypto.randomUUID(),
    },{actorUserId:platformAdminId});
    expect(result.changed).toBe(true);
    const state=await query<{
      decision_state:string; lot_state:string; account_provisional:string;
      ledger_sum:string; reversals:string;
    }>(`SELECT
       (SELECT state FROM partner_credit_award_decisions WHERE settlement_ref=$1) decision_state,
       (SELECT l.status FROM partner_credit_lots l JOIN partner_credit_award_decisions d ON d.id=l.decision_id WHERE d.settlement_ref=$1) lot_state,
       (SELECT provisional::text FROM partner_credit_accounts WHERE business_id=$2) account_provisional,
       (SELECT sum(l.units)::text FROM partner_credit_ledger l JOIN partner_credit_award_decisions d ON d.id=l.decision_id WHERE d.settlement_ref=$1) ledger_sum,
       (SELECT count(*)::text FROM partner_credit_ledger l JOIN partner_credit_award_decisions d ON d.id=l.decision_id WHERE d.settlement_ref=$1 AND l.entry_type='reverse') reversals`,
      [evidence.settlementRef,receiverId]);
    expect(state.rows[0]).toMatchObject({
      decision_state:'reversed',lot_state:'reversed',account_provisional:'0',
      ledger_sum:'0',reversals:'1',
    });
  },120000);

  it('compensates an unencumbered vested lot without negative available balance', async () => {
    const evidence=await fixture(branchIds[0]!);
    const db=await newDb();
    const award=await new PartnerProvisionalAwardService(db).decide(evidence);
    expect(award.state).toBe('provisional');
    // The vesting worker does not exist yet; create its exact projection
    // preconditions only in this disposable test database.
    await query("UPDATE partner_credit_award_decisions SET state='vested' WHERE id=$1",[award.decisionId]);
    await query("UPDATE partner_credit_lots SET status='available',available_units=1 WHERE decision_id=$1",[award.decisionId]);
    await query("UPDATE partner_credit_accounts SET provisional=provisional-1,available=available+1 WHERE business_id=$1",[receiverId]);
    const reversed=await new OrphanSettlementReversalService(db).reverse(evidence.settlementRef,{
      reasonCode:'verified-fraud',evidenceReference:'vested-'+crypto.randomUUID(),
      idempotencyKey:'s07-vested-'+crypto.randomUUID(),
    },{actorUserId:platformAdminId});
    expect(reversed.changed).toBe(true);
    const row=await query<{decision:string;lot:string;available:string;provisional:string;ledger_sum:string}>(
      `SELECT (SELECT state FROM partner_credit_award_decisions WHERE id=$1) decision,
       (SELECT status FROM partner_credit_lots WHERE decision_id=$1) lot,
       (SELECT available::text FROM partner_credit_accounts WHERE business_id=$2) available,
       (SELECT provisional::text FROM partner_credit_accounts WHERE business_id=$2) provisional,
       (SELECT sum(units)::text FROM partner_credit_ledger WHERE decision_id=$1) ledger_sum`,
      [award.decisionId,receiverId]);
    expect(row.rows[0]).toMatchObject({
      decision:'reversed',lot:'reversed',available:'0',provisional:'0',ledger_sum:'0',
    });
  },120000);

  it('fails closed on consumed lot and atomically rolls back Split 06 reversal', async () => {
    const evidence=await fixture(branchIds[1]!);
    const db=await newDb();
    const award=await new PartnerProvisionalAwardService(db).decide(evidence);
    expect(award.state).toBe('provisional');
    // Simulates the immutable consumption precondition; there is no active
    // Split 08 application writer or authorized consumption evidence yet.
    await query("UPDATE partner_credit_award_decisions SET state='vested' WHERE id=$1",[award.decisionId]);
    await query("UPDATE partner_credit_lots SET status='consumed',available_units=0 WHERE decision_id=$1",[award.decisionId]);
    await query("UPDATE partner_credit_accounts SET provisional=provisional-1 WHERE business_id=$1",[receiverId]);
    const obligationCountBefore = (await query<{count:string}>(
      'SELECT count(*)::text AS count FROM partner_credit_recovery_obligations'
    )).rows[0]!.count;
    await expect(new OrphanSettlementReversalService(db).reverse(evidence.settlementRef,{
      reasonCode:'verified-fraud',evidenceReference:'consumed-'+crypto.randomUUID(),
      idempotencyKey:'s07-consumed-'+crypto.randomUUID(),
    },{actorUserId:platformAdminId})).rejects.toThrow('PARTNER_REVERSAL_LOT_STATE_UNSUPPORTED');
    const row=await query<{settlement:string;claim:string;decision:string;reversals:string;recovery:string}>(
      `SELECT (SELECT status FROM orphan_settlements WHERE id=$1) settlement,
       (SELECT c.status FROM orphan_reward_claims c JOIN orphan_settlements s ON s.claim_id=c.id WHERE s.id=$1) claim,
       (SELECT state FROM partner_credit_award_decisions WHERE id=$2) decision,
       (SELECT count(*)::text FROM orphan_settlement_events WHERE settlement_id=$1 AND event_type='settlement_reversed') reversals,
       (SELECT count(*)::text FROM partner_credit_recovery_obligations) recovery`,
      [evidence.settlementRef,award.decisionId]);
    expect(row.rows[0]).toMatchObject({settlement:'fulfilled',claim:'settled',decision:'vested',reversals:'0',recovery:obligationCountBefore});
  },120000);

  it('serializes simultaneous award versus authorized reversal without stranded credit', async () => {
    const evidence=await fixture(branchIds[1]!);
    const awardDb=await newDb(), reversalDb=await newDb();
    const input={
      reasonCode:'verified-fraud' as const,
      evidenceReference:'s07-race-'+crypto.randomUUID(),
      idempotencyKey:'s07-race-'+crypto.randomUUID(),
    };
    const [award,reversal]=await Promise.allSettled([
      new PartnerProvisionalAwardService(awardDb).decide(evidence),
      new OrphanSettlementReversalService(reversalDb).reverse(
        evidence.settlementRef,input,{actorUserId:platformAdminId}),
    ]);
    expect(reversal.status).toBe('fulfilled');
    if(reversal.status==='fulfilled') expect(reversal.value.changed).toBe(true);
    // Either reversal locks first and the award fails closed, or award locks
    // first and the same reversal transaction compensates it.
    if(award.status==='fulfilled') expect(award.value.state).toBe('provisional');
    const state=await query<{
      decision_state:string|null; ledger_sum:string|null; reversal_count:string;
    }>(`SELECT
      (SELECT state FROM partner_credit_award_decisions WHERE settlement_ref=$1) decision_state,
      (SELECT sum(l.units)::text FROM partner_credit_ledger l JOIN partner_credit_award_decisions d ON d.id=l.decision_id WHERE d.settlement_ref=$1) ledger_sum,
      (SELECT count(*)::text FROM orphan_settlement_events WHERE settlement_id=$1 AND event_type='settlement_reversed') reversal_count`,[evidence.settlementRef]);
    expect(state.rows[0]!.reversal_count).toBe('1');
    if(state.rows[0]!.decision_state !== null) {
      expect(state.rows[0]).toMatchObject({decision_state:'reversed',ledger_sum:'0'});
    }
  },120000);

  it('rejects authoritative reversal before awarding any credits', async () => {
    const evidence=await fixture(branchIds[1]!);
    const db=await newDb();
    await new OrphanSettlementReversalService(db).reverse(evidence.settlementRef,{
      reasonCode:'verified-fraud',evidenceReference:'test-'+crypto.randomUUID(),
      idempotencyKey:'s07-reverse-'+crypto.randomUUID(),
    },{actorUserId:platformAdminId});
    await expect(new PartnerProvisionalAwardService(db).decide(evidence))
      .rejects.toThrow('PARTNER_AWARD_SETTLEMENT_EVIDENCE_INVALID');
    const result=await query<{count:string}>(
      'SELECT count(*)::text AS count FROM partner_credit_award_decisions WHERE settlement_ref=$1',
      [evidence.settlementRef]);
    expect(result.rows[0]!.count).toBe('0');
  }, 120000);
  it('serializes vested reservation against authoritative settlement reversal without double-spend', async () => {
    await resetReceivingBusinessForReversalTests();
    const evidence=await fixture(branchIds[0]!);
    const setup=await newDb();
    const awarded=await new PartnerProvisionalAwardService(setup).decide(evidence);
    expect(awarded.state).toBe('provisional');
    const vestAt=new Date(Date.parse(evidence.fulfilledAt)+15*86400_000);
    expect(await new PartnerCreditLifecycleService(setup).vest(awarded.decisionId,vestAt))
      .toBe('vested');
    const reserveDb=await newDb();
    const reversalDb=await newDb();
    const input={
      settlementRef:evidence.settlementRef,businessId:receiverId,
      decisionId:awarded.decisionId,
      invoiceIntentRef:'s08-race-intent-'+crypto.randomUUID(),
      idempotencyKey:'s08-race-reserve-'+crypto.randomUUID(),
      now:vestAt,expiresAt:new Date(vestAt.getTime()+86400_000),
    };
    const reversalInput={
      reasonCode:'verified-fraud' as const,
      evidenceReference:'s08-race-'+crypto.randomUUID(),
      idempotencyKey:'s08-reversal-'+crypto.randomUUID(),
    };
    await query('ALTER TABLE partner_credit_reservations DISABLE TRIGGER partner_credit_reservations_inert_guard');
    try {
      const [reservation,reversal]=await Promise.allSettled([
        new PartnerCreditReservationService(reserveDb).reserve(input),
        new OrphanSettlementReversalService(reversalDb).reverse(evidence.settlementRef,
          reversalInput,{actorUserId:platformAdminId}),
      ]);
      const row=(await query<{
        settlement_state:string;decision_state:string;lot_state:string;
        available:string;reserved:string;reservations:string;reversals:string;
      }>(`SELECT
          (SELECT status FROM orphan_settlements WHERE id=$1) settlement_state,
          (SELECT state FROM partner_credit_award_decisions WHERE id=$2) decision_state,
          (SELECT status FROM partner_credit_lots WHERE decision_id=$2) lot_state,
          (SELECT a.available::text FROM partner_credit_accounts a
            JOIN partner_credit_lots l ON l.account_id=a.id WHERE l.decision_id=$2) available,
          (SELECT a.reserved::text FROM partner_credit_accounts a
            JOIN partner_credit_lots l ON l.account_id=a.id WHERE l.decision_id=$2) reserved,
          (SELECT count(*)::text FROM partner_credit_reservations WHERE decision_id=$2) reservations,
          (SELECT count(*)::text FROM orphan_settlement_events
            WHERE settlement_id=$1 AND event_type='settlement_reversed') reversals`,
        [evidence.settlementRef,awarded.decisionId])).rows[0]!;
      if (reservation.status==='fulfilled') {
        // Settlement-first ordering means reversal cannot bypass a committed
        // reservation; it must fail closed until CE-1 consumption is proven.
        expect(reversal.status).toBe('rejected');
        expect(row).toMatchObject({
          settlement_state:'fulfilled',decision_state:'vested',lot_state:'reserved',
          available:'0',reserved:'1',reservations:'1',reversals:'0',
        });
      } else {
        expect(reversal.status).toBe('fulfilled');
        expect(row).toMatchObject({
          settlement_state:'reversed',decision_state:'reversed',lot_state:'reversed',
          available:'0',reserved:'0',reservations:'0',reversals:'1',
        });
      }
    } finally {
      await query('ALTER TABLE partner_credit_reservations ENABLE TRIGGER partner_credit_reservations_inert_guard');
    }
  },120000);

  it('atomically reserves one vested unit, serializes replay and denies unauthorized release', async () => {
    await resetReceivingBusinessForReversalTests();
    const evidence=await fixture(branchIds[0]!);
    const db=await newDb();
    const award=await new PartnerProvisionalAwardService(db).decide(evidence);
    expect(award.state).toBe('provisional');
    const vestAt=new Date(Date.parse(evidence.fulfilledAt)+15*86400_000);
    expect(await new PartnerCreditLifecycleService(db).vest(award.decisionId,vestAt)).toBe('vested');
    const input={
      settlementRef:evidence.settlementRef,businessId:receiverId,decisionId:award.decisionId,
      invoiceIntentRef:'s08-authorized-test-intent-'+crypto.randomUUID(),
      idempotencyKey:'s08-test-reserve-'+crypto.randomUUID(),
      now:vestAt,expiresAt:new Date(vestAt.getTime()+86400_000),
    };
    const service=new PartnerCreditReservationService(db);
    // Drizzle wraps PostgreSQL trigger messages as a query error. Direct
    // SQL denial is independently checked by the CE-1 persistence test.
    await expect(service.reserve(input)).rejects.toBeDefined();
    await query('ALTER TABLE partner_credit_reservations DISABLE TRIGGER partner_credit_reservations_inert_guard');
    try {
      const first=await service.reserve(input);
      expect(first).toMatchObject({state:'reserved',replay:false});
      expect(await service.reserve(input)).toMatchObject({
        state:'reserved',replay:true,reservationId:first.reservationId,
      });
      await expect(service.reserve({...input,idempotencyKey:'s08-other-'+crypto.randomUUID()}))
        .rejects.toThrow('PARTNER_RESERVE_LOT_NOT_ELIGIBLE');
      await expect(service.release({reservationId:first.reservationId,businessId:receiverId,now:vestAt}))
        .rejects.toThrow('SPLIT08_RELEASE_AUTHORITY_NOT_ESTABLISHED');
      const balance=await query<{available:string;reserved:string;lot_status:string;reservations:string}>(
        `SELECT a.available::text,a.reserved::text,l.status AS lot_status,
          (SELECT count(*)::text FROM partner_credit_reservations WHERE lot_id=l.id) reservations
         FROM partner_credit_lots l JOIN partner_credit_accounts a ON a.id=l.account_id
         WHERE l.decision_id=$1`,[award.decisionId]);
      expect(balance.rows[0]).toMatchObject({
        available:'0',reserved:'1',lot_status:'reserved',reservations:'1',
      });
      expect(await new PartnerCreditTerminalEvidenceReader(db).inspect(crypto.randomUUID(),receiverId))
        .toEqual({kind:'not_found'});
    } finally {
      await query('ALTER TABLE partner_credit_reservations ENABLE TRIGGER partner_credit_reservations_inert_guard');
    }
  },120000);

  it('persists inert CE-1 records only in isolated test DB with unique application and reservation keys', async () => {
    await resetReceivingBusinessForReversalTests();
    const evidence=await fixture(branchIds[0]!);
    const award=await new PartnerProvisionalAwardService(await newDb()).decide(evidence);
    expect(award.state).toBe('provisional');
    const source=await query<{lot_id:string;account_id:string}>(
      'SELECT id AS lot_id,account_id FROM partner_credit_lots WHERE decision_id=$1',[award.decisionId]);
    const lot=source.rows[0]!;
    const expiresAt=new Date(Date.now()+86400_000);
    const invoiceIntent='s08-intent-'+crypto.randomUUID();
    const reservationSql=`INSERT INTO partner_credit_reservations
      (business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`;
    const reserveArgs=[receiverId,award.decisionId,lot.lot_id,lot.account_id,invoiceIntent,'s08-reservation-'+crypto.randomUUID(),expiresAt];
    // Production barrier must deny every write, even if all references exist.
    await expect(query(reservationSql,reserveArgs)).rejects.toThrow(
      'Split 08 credit reservation/application writes disabled pending CE-1 freeze'
    );

    await query('ALTER TABLE partner_credit_reservations DISABLE TRIGGER partner_credit_reservations_inert_guard');
    await query('ALTER TABLE billing_partner_credit_applications DISABLE TRIGGER billing_partner_credit_applications_inert_guard');
    try {
      const reservation=(await query<{id:string}>(reservationSql,reserveArgs)).rows[0]!;
      await expect(query(reservationSql,[...reserveArgs.slice(0,5),'s08-repeat-'+crypto.randomUUID(),expiresAt]))
        .rejects.toMatchObject({code:'23505'});
      const plan=(await query<{id:string}>(
        "INSERT INTO subscription_plans(key,name,price_monthly_cents) VALUES($1,$2,0) RETURNING id",
        ['s08-plan-'+crypto.randomUUID(),'Disposable CE1 Plan'])).rows[0]!;
      const subscription=(await query<{id:string}>(
        "INSERT INTO business_subscriptions(business_id,plan_id,status) VALUES($1,$2,'active') RETURNING id",
        [receiverId,plan.id])).rows[0]!;
      const appSql=`INSERT INTO billing_partner_credit_applications
        (reservation_id,business_id,subscription_id,invoice_ref,provider_success_ref,idempotency_key,units_applied,terminal_state,applied_at)
        VALUES($1,$2,$3,$4,$5,$6,1,'applied',$7) RETURNING id`;
      const appArgs=[reservation.id,receiverId,subscription.id,'s08-invoice-'+crypto.randomUUID(),
        's08-provider-'+crypto.randomUUID(),'s08-app-'+crypto.randomUUID(),new Date()];
      const application=(await query<{id:string}>(appSql,appArgs)).rows[0]!;
      expect(application.id).toBeTruthy();
      await expect(query(appSql,[...appArgs.slice(0,4),'s08-other-provider-'+crypto.randomUUID(),
        's08-other-key-'+crypto.randomUUID(),new Date()]))
        .rejects.toMatchObject({code:'23505'});
      await expect(query("UPDATE billing_partner_credit_applications SET terminal_state='reversed' WHERE id=$1",[application.id]))
        .rejects.toMatchObject({code:'23514'});
      const stored=await query<{state:string;terminal:string}>(
        `SELECT r.state,a.terminal_state AS terminal FROM partner_credit_reservations r
         JOIN billing_partner_credit_applications a ON a.reservation_id=r.id WHERE r.id=$1`,
        [reservation.id]);
      expect(stored.rows[0]).toEqual({state:'reserved',terminal:'applied'});
      // Rows can be stored structurally but are NOT authoritative consumption:
      // no Stripe verification or Partner Credit consumption mutation occurred.
    } finally {
      await query('ALTER TABLE billing_partner_credit_applications ENABLE TRIGGER billing_partner_credit_applications_inert_guard');
      await query('ALTER TABLE partner_credit_reservations ENABLE TRIGGER partner_credit_reservations_inert_guard');
    }
  },120000);

  // Runs LAST (tests in this file execute in order). Earlier scenarios in this file deliberately tamper with three accounts: one
  // pre-inserts a ledger row to force an idempotency conflict, two set a lot to `consumed` by hand because no consumption writer
  // exists. The audit must flag exactly those (ledger-net divergence only) and every account produced by the real service paths
  // (award, vest, expire, offset, reversal, reservation) must audit clean.
  it('projection audit: real-service accounts audit clean; only the three deliberately tampered fixtures diverge, and only on LEDGER_NET', async () => {
    const r = await new PartnerCreditProjectionAudit(buildDb(admin)).inspect();
    if (r.status === 'unavailable') throw new Error('audit unavailable: ' + r.reason);
    expect(r.accountsInspected).toBeGreaterThanOrEqual(8);
    expect(new Set(r.violations.map(v => v.code))).toEqual(new Set(r.violations.length ? ['LEDGER_NET'] : []));
    const flagged = new Set(r.violations.map(v => v.accountId));
    expect(flagged.size).toBe(3);
    expect(r.accountsInspected - flagged.size).toBeGreaterThanOrEqual(5);
  }, 60000);

  it('projection audit detects each class of divergence on a clean account (mutations applied inside a rolled-back transaction)', async () => {
    const clean = (await query<{ account_id: string; business_id: string }>(
      `SELECT a.id AS account_id, a.business_id FROM partner_credit_accounts a
        WHERE EXISTS (SELECT 1 FROM partner_credit_ledger g WHERE g.account_id=a.id AND g.entry_type='expire')
          AND EXISTS (SELECT 1 FROM partner_credit_ledger g WHERE g.account_id=a.id AND g.entry_type='vest') LIMIT 1`)).rows[0]!;
    const audit = new PartnerCreditProjectionAudit(buildDb(admin));
    const scoped = () => audit.inspect({ businessId: clean.business_id });
    const codes = async () => { const r = await scoped(); return r.status === 'inconsistent' ? [...new Set(r.violations.map(v => v.code))].sort() : r.status; };
    const mutate = async (sql: string, params: unknown[] = []) => {
      await query('BEGIN');
      try { await query(sql, params); return await codes(); } finally { await query('ROLLBACK'); }
    };
    const acct = clean.account_id;
    expect(await codes()).toBe('consistent');
    expect(await mutate('UPDATE partner_credit_accounts SET available = available + 1 WHERE id=$1', [acct])).toEqual(expect.arrayContaining(['AVAILABLE_BUCKET', 'LEDGER_NET']));
    expect(await mutate('UPDATE partner_credit_accounts SET provisional = provisional + 1 WHERE id=$1', [acct])).toEqual(expect.arrayContaining(['PROVISIONAL_BUCKET']));
    expect(await mutate('UPDATE partner_credit_accounts SET reserved = reserved + 1 WHERE id=$1', [acct])).toEqual(expect.arrayContaining(['RESERVED_BUCKET']));
    expect(await mutate('UPDATE partner_credit_accounts SET recovery_due = recovery_due + 1 WHERE id=$1', [acct])).toEqual(expect.arrayContaining(['RECOVERY_DUE']));
    expect(await mutate("INSERT INTO partner_credit_ledger(account_id,entry_type,units,idempotency_key) VALUES($1,'expire',-1,$2)", [acct, 'audit-mutation-' + crypto.randomUUID()])).toEqual(expect.arrayContaining(['LEDGER_NET']));
    expect(await mutate("UPDATE partner_credit_award_decisions SET state='ineligible' WHERE id=(SELECT decision_id FROM partner_credit_lots WHERE account_id=$1 LIMIT 1)", [acct])).toEqual(expect.arrayContaining(['LOT_DECISION_STATE']));
    // The ledger is append-only (UPDATE/DELETE are refused), so a duplicated origin entry is the divergence that can be introduced.
    expect(await mutate("INSERT INTO partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) SELECT account_id,decision_id,'provisional',1,$2 FROM partner_credit_lots WHERE account_id=$1 LIMIT 1", [acct, 'audit-dup-origin-' + crypto.randomUUID()])).toEqual(expect.arrayContaining(['LOT_LEDGER_ORIGIN']));
    expect(await codes()).toBe('consistent'); // every mutation was rolled back
  }, 60000);

});
