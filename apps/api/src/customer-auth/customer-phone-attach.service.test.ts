import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../lib/errors';
import {
  CustomerPhoneAttachService,
  PHONE_ATTACH_MAX_FAILURES_PER_DAY,
  PHONE_ATTACH_MAX_REQUESTS_PER_DAY,
  createLocalPhoneProof,
  createTwilioPhoneProof,
  type PhoneProofPort,
} from './customer-phone-attach.service';

const ID = '11111111-1111-4111-8111-111111111111';
const PHONE = '+96566904591';
type Customer = { id: string; status: string; phone: string | null; phoneVerifiedAt: Date | null };

function build(over: { customer?: Partial<Customer> | null; counts?: Record<string, number>; proof?: Partial<PhoneProofPort>; claim?: unknown } = {}) {
  const customer: Customer | undefined = over.customer === null ? undefined : { id: ID, status: 'active', phone: null, phoneVerifiedAt: null, ...over.customer };
  const events: Array<Record<string, unknown>> = [];
  const proof: PhoneProofPort = { request: vi.fn(async () => {}), check: vi.fn(async () => true), ...over.proof };
  const customers = {
    findById: vi.fn(async () => customer),
    claimVerifiedPhone: vi.fn(async () => over.claim ?? { ok: true, customer }),
  };
  const repo = {
    append: vi.fn(async (e: Record<string, unknown>) => { events.push(e); }),
    countForCustomerSince: vi.fn(async (q: { reasonCode: string }) => over.counts?.[q.reasonCode] ?? 0),
  };
  const service = new CustomerPhoneAttachService({ customers: customers as never, events: repo as never, proof });
  return { service, customers, proof, events, repo };
}
const failure = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as AppError; } throw new Error('expected a failure'); };

describe('requesting a code', () => {
  it('normalizes the number, asks the provider once and records the request without the number', async () => {
    const { service, proof, events } = build();
    await service.requestCode(ID, ' +965 6690-4591 ');
    expect(proof.request).toHaveBeenCalledWith(PHONE);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ customerId: ID, eventType: 'otp_requested', outcome: 'success', reasonCode: 'phone_attach_requested', metadata: { surface: 'phone_attach' } });
    expect(JSON.stringify(events)).not.toContain('6690');
  });
  it('refuses a malformed or country-less number before any provider call', async () => {
    const { service, proof } = build();
    for (const bad of ['66904591', 'abc', '', null]) expect((await failure(service.requestCode(ID, bad))).code).toBe('INVALID_PHONE');
    expect(proof.request).not.toHaveBeenCalled();
  });
  it('refuses an unavailable customer', async () => {
    for (const customer of [null, { status: 'suspended' }] as const) {
      const { service, proof } = build({ customer });
      expect((await failure(service.requestCode(ID, PHONE))).code).toBe('CUSTOMER_NOT_AVAILABLE');
      expect(proof.request).not.toHaveBeenCalled();
    }
  });
  it('a verified number is not re-verified and is not replaced (change needs the step-up policy)', async () => {
    const verified = { phone: PHONE, phoneVerifiedAt: new Date() };
    expect((await failure(build({ customer: verified }).service.requestCode(ID, PHONE))).code).toBe('PHONE_ALREADY_VERIFIED');
    const other = build({ customer: verified });
    expect((await failure(other.service.requestCode(ID, '+15551234567'))).code).toBe('PHONE_CHANGE_NOT_SUPPORTED');
    expect(other.proof.request).not.toHaveBeenCalled();
  });
  it('an unverified number typed at registration may be verified', async () => {
    const { service, proof } = build({ customer: { phone: PHONE, phoneVerifiedAt: null } });
    await service.requestCode(ID, PHONE);
    expect(proof.request).toHaveBeenCalled();
  });
  it('is capped per customer per day, recorded as blocked, and sends nothing', async () => {
    const { service, proof, events } = build({ counts: { phone_attach_requested: PHONE_ATTACH_MAX_REQUESTS_PER_DAY } });
    const err = await failure(service.requestCode(ID, PHONE));
    expect(err).toMatchObject({ status: 429, code: 'PHONE_ATTACH_LIMITED' });
    expect(proof.request).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ outcome: 'blocked', reasonCode: 'phone_attach_daily_cap' });
  });
  it('a provider failure propagates and is not recorded as a sent code', async () => {
    const { service, events } = build({ proof: { request: vi.fn(async () => { throw new Error('sms down'); }) } });
    await expect(service.requestCode(ID, PHONE)).rejects.toThrow('sms down');
    expect(events).toHaveLength(0);
  });
});

describe('verifying a code', () => {
  it('a proven number becomes the verified phone, returned masked, and the success is recorded', async () => {
    const { service, customers, events } = build();
    expect(await service.verifyCode(ID, PHONE, '123456')).toEqual({ phoneMasked: '+•••••••4591', verified: true });
    expect(customers.claimVerifiedPhone).toHaveBeenCalledWith(ID, PHONE);
    expect(events.at(-1)).toMatchObject({ eventType: 'otp_verified', outcome: 'success', reasonCode: 'phone_attach_completed' });
  });
  it('a wrong code is one generic 401, recorded, and links nothing', async () => {
    const { service, customers, events } = build({ proof: { check: vi.fn(async () => false) } });
    expect(await failure(service.verifyCode(ID, PHONE, '000000'))).toMatchObject({ status: 401, code: 'OTP_INVALID' });
    expect(customers.claimVerifiedPhone).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ eventType: 'otp_failed', reasonCode: 'phone_attach_failed' });
  });
  it('a malformed code never reaches the provider', async () => {
    const { service, proof } = build();
    for (const bad of ['', 'abcdef', '12', '12345678901', null, 123456]) expect((await failure(service.verifyCode(ID, PHONE, bad))).code).toBe('OTP_INVALID');
    expect(proof.check).not.toHaveBeenCalled();
  });
  it('a number already verified on another account is refused with PHONE_TAKEN and nothing is linked', async () => {
    const { service, events } = build({ claim: { ok: false, reason: 'taken' } });
    expect(await failure(service.verifyCode(ID, PHONE, '123456'))).toMatchObject({ status: 409, code: 'PHONE_TAKEN' });
    expect(events.at(-1)).toMatchObject({ outcome: 'blocked', reasonCode: 'phone_attach_taken' });
  });
  it('a lockout from the provider (too many attempts) propagates and is recorded', async () => {
    const lock = new AppError('Too many incorrect attempts.', 429, 'OTP_MAX_ATTEMPTS');
    const { service, events } = build({ proof: { check: vi.fn(async () => { throw lock; }) } });
    expect(await failure(service.verifyCode(ID, PHONE, '123456'))).toBe(lock);
    expect(events[0]).toMatchObject({ eventType: 'otp_failed', outcome: 'failure' });
  });
  it('is capped per customer per day on failures, before the provider is asked', async () => {
    const { service, proof } = build({ counts: { phone_attach_failed: PHONE_ATTACH_MAX_FAILURES_PER_DAY } });
    expect(await failure(service.verifyCode(ID, PHONE, '123456'))).toMatchObject({ status: 429, code: 'PHONE_ATTACH_LIMITED' });
    expect(proof.check).not.toHaveBeenCalled();
  });
  it('a verified number cannot be verified again or replaced', async () => {
    const { service } = build({ customer: { phone: PHONE, phoneVerifiedAt: new Date() } });
    expect((await failure(service.verifyCode(ID, PHONE, '123456'))).code).toBe('PHONE_ALREADY_VERIFIED');
    expect((await failure(service.verifyCode(ID, '+15551234567', '123456'))).code).toBe('PHONE_CHANGE_NOT_SUPPORTED');
  });
});

describe('status', () => {
  it('reports a masked number and whether it is verified, never the number itself', async () => {
    expect(await build({ customer: { phone: PHONE, phoneVerifiedAt: null } }).service.status(ID)).toEqual({ phoneMasked: '+•••••••4591', verified: false });
    expect(await build().service.status(ID)).toEqual({ phoneMasked: null, verified: false });
    expect(await build({ customer: { phone: PHONE, phoneVerifiedAt: new Date() } }).service.status(ID)).toEqual({ phoneMasked: '+•••••••4591', verified: true });
  });
});

describe('provider ports', () => {
  it('the local port maps an invalid code to false but lets lockouts through', async () => {
    const auth = { requestOtp: vi.fn(async () => {}), consumeOtp: vi.fn() };
    const port = createLocalPhoneProof(auth as never);
    auth.consumeOtp.mockResolvedValueOnce(undefined);
    expect(await port.check(PHONE, '123456')).toBe(true);
    auth.consumeOtp.mockRejectedValueOnce(new AppError('x', 401, 'OTP_INVALID'));
    expect(await port.check(PHONE, '000000')).toBe(false);
    const lock = new AppError('x', 429, 'OTP_MAX_ATTEMPTS');
    auth.consumeOtp.mockRejectedValueOnce(lock);
    await expect(port.check(PHONE, '000000')).rejects.toBe(lock);
  });
  it('the Twilio port delegates to Verify without sending anything itself', async () => {
    const twilio = { request: vi.fn(async () => {}), check: vi.fn(async () => true) };
    const port = createTwilioPhoneProof(twilio as never);
    await port.request(PHONE);
    expect(await port.check(PHONE, '123456')).toBe(true);
    expect(twilio.request).toHaveBeenCalledWith(PHONE);
  });
});
