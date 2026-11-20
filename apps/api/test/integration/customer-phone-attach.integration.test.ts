import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { sql } from 'drizzle-orm';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { createDirectPbkdf2Worker } from '../../src/auth/pbkdf2-worker';
import { CustomerAuthService } from '../../src/customer-auth/customer-auth.service';
import { CustomerAuthEventRepository } from '../../src/repositories/customer-auth-event.repository';
import { CustomerPhoneAttachService, createLocalPhoneProof, PHONE_ATTACH_MAX_REQUESTS_PER_DAY } from '../../src/customer-auth/customer-phone-attach.service';
import { CustomerMembershipService } from '../../src/customer-relationships/customer-membership.service';
import { createEmailRegistrationService } from '../../src/customer-auth/customer-email-auth.service';
import { CustomerCredentialRepository } from '../../src/repositories/customer-credential.repository';
import { appDbOf } from '../helpers/runtime-db';

/**
 * CUSTOMER-PHONE-01 stage 4 against real Postgres, with the real OTP rows and hasher. Only the SMS transport is faked (it
 * captures the code that would be sent); nothing is sent anywhere.
 */
describe.skipIf(!process.env.DATABASE_URL)('Phone attach (real Postgres)', () => {
  let client: Client;
  let db: ReturnType<typeof buildDb>;
  let repos: ReturnType<typeof createRepositories>;
  let events: CustomerAuthEventRepository;
  let service: CustomerPhoneAttachService;
  const sent = new Map<string, string>();
  const phone = () => `+1558${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  const emailCustomer = async () => (await repos.customers.create({})).id;
  const codeFor = (number: string) => sent.get(number)!;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    db = buildDb(client);
    repos = createRepositories(db);
    events = new CustomerAuthEventRepository(db);
    const auth = new CustomerAuthService(
      repos,
      { send: async (to: string, body: string) => { sent.set(to, /(\d{6})/.exec(body)![1]!); } } as never,
      { CUSTOMER_JWT_SECRET: 'unused-in-attach-0123456789abcdef' },
      createDirectPbkdf2Worker(),
    );
    service = new CustomerPhoneAttachService({ customers: repos.customers, events, proof: createLocalPhoneProof(auth) });
  });
  afterAll(async () => {
    await client.end();
  });

  it('an email-only customer verifies a phone: it becomes their verified number and the audit trail holds no number or code', async () => {
    const id = await emailCustomer();
    const number = phone();
    await service.requestCode(id, number);
    const status = await service.verifyCode(id, number, codeFor(number));
    expect(status).toMatchObject({ verified: true });
    const row = (await repos.customers.findById(id))!;
    expect(row.phone).toBe(number);
    expect(row.phoneVerifiedAt).not.toBeNull();
    expect((await repos.customers.findVerifiedByPhone(number))!.id).toBe(id);
    const trail = await events.listForCustomer(id);
    expect(trail.map((e) => `${e.eventType}:${e.outcome}:${e.reasonCode}`)).toEqual(expect.arrayContaining([
      'otp_requested:success:phone_attach_requested', 'otp_verified:success:phone_attach_completed',
    ]));
    expect(JSON.stringify(trail)).not.toContain(number.slice(-7));
    expect(JSON.stringify(trail)).not.toContain(codeFor(number));
  });

  it('verifying unlocks what the gate withheld: a second business, refused before and allowed after', async () => {
    const suffix = crypto.randomUUID();
    const a = (await repos.businesses.create({ name: 'Attach A', slug: `attach-a-${suffix}` })).id;
    const b = (await repos.businesses.create({ name: 'Attach B', slug: `attach-b-${suffix}` })).id;
    const memberships = new CustomerMembershipService(appDbOf(db));
    const id = await emailCustomer();
    const join = (businessId: string) =>
      memberships.join({ customerId: id, businessId, onboardingSource: 'business_qr', onboardingReference: 'attach-test', consentVersion: 'v1' });
    await join(a);
    await expect(join(b)).rejects.toMatchObject({ code: 'PHONE_VERIFICATION_REQUIRED' });
    const number = phone();
    await service.requestCode(id, number);
    await service.verifyCode(id, number, codeFor(number));
    await expect(join(b)).resolves.toBeTruthy();
  });

  it('a wrong code is refused and counted; five wrong codes lock that code; the number is never linked', async () => {
    const id = await emailCustomer();
    const number = phone();
    await service.requestCode(id, number);
    for (let i = 0; i < 5; i += 1) await expect(service.verifyCode(id, number, '000000' === codeFor(number) ? '111111' : '000000')).rejects.toMatchObject({ code: 'OTP_INVALID' });
    await expect(service.verifyCode(id, number, codeFor(number))).rejects.toMatchObject({ code: 'OTP_MAX_ATTEMPTS' });
    expect((await repos.customers.findById(id))!.phone).toBeNull();
    const failed = (await events.listForCustomer(id)).filter((e) => e.eventType === 'otp_failed');
    expect(failed.length).toBeGreaterThanOrEqual(5);
  });

  it('a number already verified on another account is refused (PHONE_TAKEN) and the second account stays unlinked', async () => {
    const first = await emailCustomer();
    const second = await emailCustomer();
    const number = phone();
    await service.requestCode(first, number);
    await service.verifyCode(first, number, codeFor(number));
    await service.requestCode(second, number);
    await expect(service.verifyCode(second, number, codeFor(number))).rejects.toMatchObject({ status: 409, code: 'PHONE_TAKEN' });
    expect((await repos.customers.findById(second))!.phoneVerifiedAt).toBeNull();
    expect((await repos.customers.findVerifiedByPhone(number))!.id).toBe(first);
  });

  it('verifying releases unverified claims by others on the same number but never touches their accounts', async () => {
    const number = phone();
    const squatter = (await repos.customers.create({ phone: number })).id;
    const owner = await emailCustomer();
    await service.requestCode(owner, number);
    await service.verifyCode(owner, number, codeFor(number));
    const after = (await repos.customers.findById(squatter))!;
    expect(after.phone).toBeNull();
    expect(after.status).toBe('active');
  });

  it('a verified number is not replaced, and a suspended customer cannot start', async () => {
    const id = await emailCustomer();
    const number = phone();
    await service.requestCode(id, number);
    await service.verifyCode(id, number, codeFor(number));
    await expect(service.requestCode(id, phone())).rejects.toMatchObject({ code: 'PHONE_CHANGE_NOT_SUPPORTED' });
    await expect(service.requestCode(id, number)).rejects.toMatchObject({ code: 'PHONE_ALREADY_VERIFIED' });
    const suspended = await emailCustomer();
    await db.execute(sql`update customers set status = 'suspended' where id = ${suspended}`);
    await expect(service.requestCode(suspended, phone())).rejects.toMatchObject({ code: 'CUSTOMER_NOT_AVAILABLE' });
  });

  it('the per-customer daily request cap is enforced from the real audit trail', async () => {
    const id = await emailCustomer();
    for (let i = 0; i < PHONE_ATTACH_MAX_REQUESTS_PER_DAY; i += 1) await service.requestCode(id, phone());
    await expect(service.requestCode(id, phone())).rejects.toMatchObject({ status: 429, code: 'PHONE_ATTACH_LIMITED' });
  });

  it('the per-number cooldown stops a second code to the same number inside a minute', async () => {
    const id = await emailCustomer();
    const number = phone();
    await service.requestCode(id, number);
    await expect(service.requestCode(id, number)).rejects.toMatchObject({ code: 'OTP_COOLDOWN' });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('Phone captured at registration (real Postgres)', () => {
  let client: Client;
  let db: ReturnType<typeof buildDb>;
  let repos: ReturnType<typeof createRepositories>;
  let register: ReturnType<typeof createEmailRegistrationService>;
  const delivered: Array<{ recipient: string; challengeId: string; proof: string }> = [];
  const password = 'correct horse battery staple 42';

  async function signUp(phone: string | undefined) {
    const email = `reg-${crypto.randomUUID()}@example.test`;
    delivered.length = 0;
    await register.requestProof(email);
    const m = delivered.find((d) => d.recipient === email)!;
    const result = await register.completeRegistration({ email, challengeId: m.challengeId, proof: m.proof, password, phone });
    return { email, result };
  }

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    db = buildDb(client);
    repos = createRepositories(db);
    register = createEmailRegistrationService({
      db, hmacSecret: 'h'.repeat(40), passwordPolicy: { minLength: 12 }, hasher: createDirectPbkdf2Worker(),
      deliver: async (m) => { delivered.push(m); },
    });
  });
  afterAll(async () => {
    await client.end();
  });

  it('stores a typed number normalized and UNVERIFIED: it proves nothing and finds nobody', async () => {
    const { email, result } = await signUp(' +965 6690 4591 ');
    expect(result).toMatchObject({ ok: true });
    const credential = (await new CustomerCredentialRepository(db).findByLoginEmail(email))!;
    const customer = (await repos.customers.findById(credential.customerId))!;
    expect(customer.phone).toBe('+96566904591');
    expect(customer.phoneVerifiedAt).toBeNull();
    expect(await repos.customers.findVerifiedByPhone('+96566904591')).toBeUndefined();
  });

  it('two sign-ups may type the same number (unverified claims repeat) and neither gets a verified status', async () => {
    const number = `+1557${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
    expect((await signUp(number)).result).toMatchObject({ ok: true });
    expect((await signUp(number)).result).toMatchObject({ ok: true });
    expect((await repos.customers.listByPhone(number)).every((c) => !c.phoneVerifiedAt)).toBe(true);
  });

  it('a malformed number refuses the registration and creates nothing; no number is optional', async () => {
    const bad = await signUp('66904591');
    expect(bad.result).toMatchObject({ ok: false });
    expect(await new CustomerCredentialRepository(db).findByLoginEmail(bad.email)).toBeUndefined();
    const none = await signUp(undefined);
    expect(none.result).toMatchObject({ ok: true });
    const credential = (await new CustomerCredentialRepository(db).findByLoginEmail(none.email))!;
    expect((await repos.customers.findById(credential.customerId))!.phone).toBeNull();
  });
});
