import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CommunityMembershipService } from '../../src/community/community-membership.service';
import { CommunityPlatformStateService } from '../../src/community/community-platform-state.service';
import { publishSyntheticCommunityTerms } from '../helpers/community-consent-fixtures';
import { COMMUNITY_TERMS_LOCK, communityRequestKey } from '../../src/community/community-consent.persistence';
import { ConsentWithdrawalService } from '../../src/consent/consent-withdrawal.service';

const url = process.env.DATABASE_URL;
if (url && !['127.0.0.1','localhost'].includes(new URL(url).hostname)) throw new Error('Loopback disposable database required');
describe.skipIf(!url)('NETWORK-15-T2 consent and D1 runtime (PostgreSQL)', () => {
  const client = new Client({ connectionString: url }); const db = buildDb(client);
  const service = new CommunityMembershipService(db); const platform = new CommunityPlatformStateService(db);
  const extra: Client[] = []; let actor: string;
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  const customer = async (verified = true) => (await createRepositories(db).customers.create({ phone: `+1556${Math.floor(Math.random()*9e8)}`, phoneVerifiedAt: verified ? new Date() : null })).id;
  const terms = () => publishSyntheticCommunityTerms(`synthetic-${crypto.randomUUID()}`);
  const audit = () => ({ actorUserId: actor, ipAddress: null, userAgent: null });
  async function opened() { const c = new Client({ connectionString: url }); await c.connect(); extra.push(c); return c; }
  async function input(id: string, publish = true) {
    if (publish) await terms(); const offer = await service.getOffer(id, 'en'); if (!offer) throw new Error('Fixture offer missing');
    return { operation: offer.operation, consentAccepted: true, expectedPublicationId: offer.terms.publicationId, expectedTermsVersion: offer.terms.version,
      expectedTermsHash: offer.terms.manifestHash, expectedArtifactHash: offer.terms.contentHash, displayedLocale: 'en', expectedTransitionId: offer.transitionId, idempotencyKey: crypto.randomUUID() };
  }
  async function counts(id: string) {
    const result: number[] = [];
    for (const table of ['community_memberships','community_point_accounts','consent_grants']) result.push(Number((await q(`select count(*) n from ${table} where customer_id=$1`,[id]))[0].n));
    result.push(Number((await q("select count(*) n from audit_log where action='community_membership.consent_transition' and metadata->>'customerId'=$1",[id]))[0].n)); return result;
  }
  beforeAll(async () => { await client.connect(); actor = (await q("insert into users(email,password_hash,full_name,status,platform_role) values($1,'x','Synthetic','active','admin') returning id",[`t2-${crypto.randomUUID()}@example.test`]))[0].id; });
  beforeEach(async () => { await q('update community_terms_current set publication_id=null'); });
  afterAll(async () => { for (const c of extra) await c.end().catch(() => undefined); await client.end(); });

  it('T2-01/02/21 no approved terms deny Join/Rejoin; Leave remains usable', async () => {
    const id=await customer(); await expect(service.join(id, {})).rejects.toMatchObject({ code:'COMMUNITY_TERMS_UNAVAILABLE' }); expect(await counts(id)).toEqual([0,0,0,0]);
    await service.join(id,await input(id)); await service.leave(id); await q('update community_terms_current set publication_id=null');
    await expect(service.join(id,{})).rejects.toMatchObject({ code:'COMMUNITY_TERMS_UNAVAILABLE' }); expect((await service.leave(id)).membership?.status).toBe('left');
  });
  it.each(['draft','future'])('T2-03/04 %s publication cannot become current', async (kind) => {
    const p=await terms(); const record={...p,id:crypto.randomUUID(),version:`synthetic-${crypto.randomUUID()}`,...(kind==='future'?{effectiveAt:'2099-01-01T00:00:00Z'}:{approval:{...p.approval,status:'draft'}})};
    await q('insert into community_terms_publications(id,version,publication) values($1,$2,$3)',[record.id,record.version,record]);
    await expect(q('update community_terms_current set publication_id=$1',[record.id])).rejects.toMatchObject({code:'23000'});
  });
  it.each(['expectedTermsVersion','expectedTermsHash','expectedPublicationId','expectedArtifactHash'])('T2-05/07 forged %s is denied', async (key) => {
    const id=await customer(); const raw=await input(id); const value=key.endsWith('Id')?crypto.randomUUID():key.endsWith('Hash')?'0'.repeat(64):'unknown';
    await expect(service.join(id,{...raw,[key]:value})).rejects.toMatchObject({code:'COMMUNITY_ACCEPTANCE_STALE'}); expect(await counts(id)).toEqual([0,0,0,0]);
  });
  it.each([{consentAccepted:false},{consentAccepted:'true'},{consentAccepted:null},{acceptedAt:'2020-01-01'},{verified:true},{customerId:crypto.randomUUID()},{approved:true}])('T2-06/08/19 rejects forged authority %j', async (extra) => {
    const id=await customer(); await expect(service.join(id,{...await input(id),...extra})).rejects.toMatchObject({code:'COMMUNITY_CONSENT_REQUIRED'}); expect(await counts(id)).toEqual([0,0,0,0]);
  });
  it('T2-09/10 current phone and customer status are revalidated', async () => {
    const id=await customer(false); const raw=await input(id); await expect(service.join(id,raw)).rejects.toMatchObject({code:'PHONE_VERIFICATION_REQUIRED'});
    await q("update customers set status='suspended' where id=$1",[id]); await expect(service.join(id,raw)).rejects.toMatchObject({code:'CUSTOMER_NOT_AVAILABLE'});
  });
  it('T2-11/12 six concurrent Join/Rejoin requests commit one transition', async () => {
    const id=await customer(); const raw=await input(id); const clients=await Promise.all(Array.from({length:6},()=>opened()));
    const joined=await Promise.all(clients.map(c=>new CommunityMembershipService(buildDb(c)).join(id,raw))); expect(joined.filter(r=>r.created)).toHaveLength(1); expect(await counts(id)).toEqual([1,1,1,1]);
    await service.leave(id); const again=await input(id,false); const rejoined=await Promise.all(clients.map(c=>new CommunityMembershipService(buildDb(c)).join(id,again)));
    expect(rejoined.filter(r=>r.reactivated)).toHaveLength(1); expect(new Set(rejoined.map(r=>r.membership.id))).toEqual(new Set([joined[0]!.membership.id])); expect(new Set(rejoined.map(r=>r.account.id))).toEqual(new Set([joined[0]!.account.id]));
    expect((await q("select count(*)::int n from audit_log where entity_id=$1 and metadata->>'operation'='rejoin'",[joined[0]!.membership.id]))[0].n).toBe(1);
  });
  it.each(['audit_log','consent_grants','community_memberships'])('T2-13/14 %s insert failure rolls back acceptance and activation', async (table) => {
    const id=await customer(); const raw=await input(id); const name=`t2_failure_${crypto.randomUUID().replaceAll('-','')}`; const condition=table==='audit_log'?`NEW.metadata->>'customerId'='${id}'`:`NEW.customer_id='${id}'::uuid`;
    await q(`create function ${name}() returns trigger language plpgsql as $$ begin if ${condition} then raise exception 'SYNTHETIC_FAILURE'; end if; return NEW; end $$`); await q(`create trigger ${name} before insert on ${table} for each row execute function ${name}()`);
    try { await expect(service.join(id,raw)).rejects.toThrow(); expect(await counts(id)).toEqual([0,0,0,0]); } finally { await q(`drop trigger ${name} on ${table}`); await q(`drop function ${name}()`); }
  });
  it('T2-15/17/18 stale Join cannot resurrect Leave, history and balances stay independent', async () => {
    const id=await customer(); const raw=await input(id); const first=await service.join(id,raw); await q('update community_point_accounts set points_balance=73 where customer_id=$1',[id]);
    const before=(await q('select count(*)::int n from loyalty_transactions'))[0].n; await service.leave(id); await service.leave(id);
    await expect(service.join(id,raw)).rejects.toMatchObject({code:'COMMUNITY_ACCEPTANCE_STALE'}); const again=await service.join(id,await input(id,false)); expect(again.account.pointsBalance).toBe(73); expect(again.account.id).toBe(first.account.id);
    expect((await q('select count(*)::int n from loyalty_transactions'))[0].n).toBe(before); await expect(q("update audit_log set metadata='{}' where id=$1",[first.consent.transitionId])).rejects.toThrow('AUDIT_LOG_IMMUTABLE');
  });
  it('T2-20/22 legacy strings cannot activate; GET reads create no evidence or accounts', async () => {
    const id=await customer(); await terms(); await service.getStatus(id); await service.getOffer(id,'en');
    await expect(service.join(id,'legacy-version')).rejects.toMatchObject({code:'COMMUNITY_CONSENT_REQUIRED'}); expect(await counts(id)).toEqual([0,0,0,0]);
  });
  it('T2-19 another consent domain cannot reserve a Community acceptance key', async () => {
    const id=await customer(); const bystander=await customer(); const raw=await input(id);
    const forged=await communityRequestKey(id,raw.idempotencyKey);
    await q("insert into consent_grants(customer_id,purpose,idempotency_key) values($1,'marketing',$2)",[bystander,forged]);
    expect((await service.join(id,raw)).membership.customerId).toBe(id);
    expect((await q("select count(*)::int n from consent_grants where customer_id=$1 and purpose='marketing' and status='active'",[bystander]))[0].n).toBe(1);
  });
  it('T2-23 publisher-first lock ordering rejects a stale browser after publication commits', async () => {
    const id=await customer(); const raw=await input(id); const next=await terms(); await q('update community_terms_current set publication_id=$1',[raw.expectedPublicationId]);
    const holder=await opened(); const joining=await opened(); await holder.query('begin'); await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[COMMUNITY_TERMS_LOCK]);
    const pending=new CommunityMembershipService(buildDb(joining)).join(id,raw).then(()=>null,(e:unknown)=>e);
    try { let waiting=0; const deadline=Date.now()+5_000; do {waiting=Number((await q("select count(*) n from pg_locks where locktype='advisory' and not granted and ((classid::bigint<<32)|objid::bigint)=hashtextextended($1,0)",[COMMUNITY_TERMS_LOCK]))[0].n);}while(!waiting&&Date.now()<deadline);
      expect(waiting).toBeGreaterThan(0); await holder.query('update community_terms_current set publication_id=$1',[next.id]); await holder.query('commit'); expect(await pending).toMatchObject({code:'COMMUNITY_ACCEPTANCE_STALE'}); expect(await counts(id)).toEqual([0,0,0,0]);
    }finally{await holder.query('rollback'); await pending;}
  });
  it('T2-24 published records cannot change; read-only runtime cannot mutate authority', async () => {
    const p=await terms(); await expect(q("update community_terms_publications set publication='{}' where id=$1",[p.id])).rejects.toThrow('COMMUNITY_TERMS_IMMUTABLE'); await expect(q('delete from community_terms_publications where id=$1',[p.id])).rejects.toThrow('COMMUNITY_TERMS_IMMUTABLE');
    const role=`t2_reader_${crypto.randomUUID().replaceAll('-','')}`; const c=await opened(); await q(`create role ${role} nologin nosuperuser nobypassrls`); await q(`grant usage on schema public to ${role}`); await q(`grant select on community_terms_current,community_terms_publications to ${role}`);
    try{await c.query(`set role ${role}`); await expect(c.query('update community_terms_current set publication_id=null')).rejects.toMatchObject({code:'42501'}); await expect(c.query('delete from community_terms_publications')).rejects.toMatchObject({code:'42501'});}finally{await c.query('reset role'); await q(`drop owned by ${role}`); await q(`drop role ${role}`);}
  });
  it('RESTORE-01/07 needs current consent and authoritative phone', async () => {
    const id=await customer(); await service.join(id,await input(id)); await platform.suspend(id,{reason:'Synthetic moderation.'},audit()); await q('update customers set phone_verified_at=null where id=$1',[id]);
    await expect(platform.restore(id,{reason:'Synthetic clearance.'},audit())).rejects.toMatchObject({code:'PHONE_VERIFICATION_REQUIRED'}); await q('update customers set phone_verified_at=now() where id=$1',[id]); expect((await platform.restore(id,{reason:'Synthetic clearance.'},audit())).membership.status).toBe('active');
  });
  it('RESTORE-02 stale consent clears moderation without activation; fresh acceptance works', async () => {
    const id=await customer(); await service.join(id,await input(id)); await platform.suspend(id,{reason:'Synthetic moderation.'},audit()); await terms(); const cleared=await platform.restore(id,{reason:'Synthetic clearance.'},audit());
    expect(cleared.membership.status).toBe('inactive'); expect(cleared.membership.leftAt).toBeNull(); expect(cleared.account.status).toBe('closed'); expect((await service.join(id,await input(id,false))).membership.status).toBe('active');
  });
  it('RESTORE-03/08 legacy acceptance is never fabricated, including an empty registry', async () => {
    const id=await customer(); const repos=createRepositories(db); await repos.communityMemberships.create({customerId:id,status:'active',policyVersion:'legacy-unknown'}); await repos.communityPointAccounts.create({customerId:id,status:'active',pointsBalance:51});
    await platform.suspend(id,{reason:'Synthetic moderation.'},audit()); const result=await platform.restore(id,{reason:'Synthetic clearance.'},audit()); expect(result.membership.status).toBe('inactive'); expect(result.account.pointsBalance).toBe(51); expect((await counts(id))[2]).toBe(0);
  });
  it('RESTORE-04/05 voluntary Leave and customer suspension cannot be bypassed', async () => {
    const id=await customer(); await service.join(id,await input(id)); await service.leave(id); await expect(platform.restore(id,{reason:'Synthetic clearance.'},audit())).rejects.toMatchObject({code:'COMMUNITY_STATE_CONFLICT'});
    const other=await customer(); await service.join(other,await input(other)); await platform.suspend(other,{reason:'Synthetic moderation.'},audit()); await q("update customers set status='suspended' where id=$1",[other]); await expect(platform.restore(other,{reason:'Synthetic clearance.'},audit())).rejects.toMatchObject({code:'CUSTOMER_NOT_AVAILABLE'});
  });
  it('RESTORE-06 a successful Leave racing Restore remains authoritative', async () => {
    const id=await customer(); await service.join(id,await input(id)); await platform.suspend(id,{reason:'Synthetic moderation.'},audit()); const c=await opened();
    const result=await Promise.allSettled([platform.restore(id,{reason:'Synthetic clearance.'},audit()),new CommunityMembershipService(buildDb(c)).leave(id)]);
    if(result[1]!.status==='fulfilled')expect((await service.getStatus(id)).membership?.status).toBe('left'); else {expect(result[1]!.reason).toMatchObject({code:'COMMUNITY_MEMBERSHIP_SUSPENDED'}); await service.leave(id);}
    await expect(platform.restore(id,{reason:'Synthetic clearance.'},audit())).rejects.toMatchObject({code:'COMMUNITY_STATE_CONFLICT'});
  });
  it('missing registry schema fails closed while legacy-compatible Leave remains usable', async () => {
    const id=await customer(); await service.join(id,await input(id));
    const suspended=await customer(); await service.join(suspended,await input(suspended)); await platform.suspend(suspended,{reason:'Synthetic moderation.'},audit());
    await q('alter table community_terms_current rename to community_terms_unavailable_fixture');
    try {
      expect(await service.getOffer(id,'en')).toBeNull();
      await expect(service.join(await customer(),{})).rejects.toMatchObject({code:'COMMUNITY_TERMS_UNAVAILABLE'});
      await expect(platform.restore(suspended,{reason:'Synthetic clearance.'},audit())).rejects.toMatchObject({code:'COMMUNITY_TERMS_UNAVAILABLE'});
      expect((await service.getStatus(suspended)).membership?.status).toBe('suspended');
      expect((await service.leave(id)).membership?.status).toBe('left');
    } finally { await q('alter table community_terms_unavailable_fixture rename to community_terms_current'); }
  });
  it('customer-owned Community consent withdrawal is atomic Leave; another customer cannot revoke it', async () => {
    const id=await customer(); const other=await customer(); const joined=await service.join(id,await input(id));
    const grant=(await q("select id from consent_grants where customer_id=$1 and purpose='community_membership'",[id]))[0].id;
    const withdrawal=new ConsentWithdrawalService(db);
    expect(await withdrawal.revoke(grant,other)).toBe(false); expect((await service.getStatus(id)).membership?.status).toBe('active');
    expect(await withdrawal.revoke(grant,id)).toBe(true); const status=await service.getStatus(id);
    expect(status.membership?.status).toBe('left'); expect(status.account?.id).toBe(joined.account.id);
    expect((await q('select status from consent_grants where id=$1',[grant]))[0].status).toBe('revoked');
    expect(await withdrawal.revoke(grant,id)).toBe(false);
  });
});
