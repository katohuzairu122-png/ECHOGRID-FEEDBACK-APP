import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CustomerAuthService } from './customer-auth.service';
import type { SmsService } from './sms.service';
import { OTP_MAX_ATTEMPTS } from './otp';
import type { Customer, NewCustomer } from '../repositories/customer.repository';
import type { OtpCode, NewOtpCode } from '../repositories/otp-code.repository';

/** Same fake-repo style as auth.service.test.ts's createFakeRepos. */
function createFakeRepos() {
  const customers = new Map<string, Customer>();
  const otpCodes = new Map<string, OtpCode>();

  return {
    customers: {
      async findByPhone(phone: string) {
        return [...customers.values()].find((c) => c.phone === phone && !c.isDeleted);
      },
      async create(input: NewCustomer): Promise<Customer> {
        const customer: Customer = {
          id: crypto.randomUUID(),
          phone: input.phone,
          fullName: input.fullName ?? null,
          email: input.email ?? null,
          birthday: input.birthday ?? null,
          phoneVerifiedAt: (input.phoneVerifiedAt as Date | undefined) ?? null,
          status: input.status ?? 'active',
          createdAt: new Date(),
          createdBy: input.createdBy ?? null,
          updatedAt: new Date(),
          updatedBy: input.updatedBy ?? null,
          isDeleted: false,
          deletedAt: null,
          deletedBy: null,
        };
        customers.set(customer.id, customer);
        return customer;
      },
      async markPhoneVerified(id: string) {
        const customer = customers.get(id);
        if (customer) customer.phoneVerifiedAt = new Date();
        return customer;
      },
    },
    otpCodes: {
      async create(input: NewOtpCode): Promise<OtpCode> {
        const row: OtpCode = {
          id: crypto.randomUUID(),
          phone: input.phone,
          codeHash: input.codeHash,
          expiresAt: input.expiresAt,
          attempts: 0,
          consumedAt: null,
          createdAt: new Date(),
        };
        otpCodes.set(row.id, row);
        return row;
      },
      async findLatestForPhone(phone: string) {
        return [...otpCodes.values()]
          .filter((c) => c.phone === phone)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      },
      async findActiveForPhone(phone: string) {
        return [...otpCodes.values()]
          .filter((c) => c.phone === phone && !c.consumedAt && c.expiresAt > new Date())
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      },
      async incrementAttempts(id: string) {
        const row = otpCodes.get(id);
        if (row) row.attempts += 1;
      },
      async markConsumed(id: string) {
        const row = otpCodes.get(id);
        if (row) row.consumedAt = new Date();
      },
    },
  };
}

/** Captures the sent code instead of actually sending it -- the same
 * "capture, don't call out" idea Twilio's real send() would need mocking
 * for, but ConsoleSmsService already exists for dev; this fake exists so
 * the test can read the code back and complete a full request-then-verify
 * cycle without parsing console output. */
function createFakeSmsService(): SmsService & { lastMessage?: string | undefined; lastPhone?: string | undefined } {
  const fake = {
    lastMessage: undefined as string | undefined,
    lastPhone: undefined as string | undefined,
    async send(toPhone: string, body: string) {
      fake.lastPhone = toPhone;
      fake.lastMessage = body;
    },
  };
  return fake;
}

function extractCode(message: string): string {
  const match = message.match(/\d{6}/);
  if (!match) throw new Error('No 6-digit code found in SMS body');
  return match[0];
}

const SECRETS = { CUSTOMER_JWT_SECRET: 'customer-jwt-test-secret' };
const PHONE = '+15551234567';

describe('CustomerAuthService', () => {
  let repos: ReturnType<typeof createFakeRepos>;
  let sms: ReturnType<typeof createFakeSmsService>;
  let service: CustomerAuthService;

  beforeEach(() => {
    repos = createFakeRepos();
    sms = createFakeSmsService();
    service = new CustomerAuthService(
      repos as unknown as ConstructorParameters<typeof CustomerAuthService>[0],
      sms,
      SECRETS,
    );
  });

  it('requestOtp sends an SMS containing a 6-digit code', async () => {
    await service.requestOtp(PHONE);
    expect(sms.lastPhone).toBe(PHONE);
    expect(sms.lastMessage).toMatch(/\d{6}/);
  });

  it('requestOtp stores a hashed code, never the raw code, in the repository', async () => {
    await service.requestOtp(PHONE);
    const stored = await repos.otpCodes.findLatestForPhone(PHONE);
    const code = extractCode(sms.lastMessage!);
    expect(stored?.codeHash).not.toBe(code);
    expect(stored?.codeHash.startsWith('pbkdf2$')).toBe(true);
  });

  it('requestOtp rejects a second request within the cooldown window', async () => {
    await service.requestOtp(PHONE);
    await expect(service.requestOtp(PHONE)).rejects.toMatchObject({ code: 'OTP_COOLDOWN' });
  });

  it('a full request-then-verify cycle issues a customer session and creates the customer row', async () => {
    await service.requestOtp(PHONE);
    const code = extractCode(sms.lastMessage!);

    const result = await service.verifyOtp(PHONE, code);
    expect(result.accessToken).toBeTruthy();
    expect(result.customer.phone).toBe(PHONE);
    expect(result.customer.phoneVerifiedAt).not.toBeNull();
  });

  it('verifying twice with the same code fails the second time -- a code is single-use', async () => {
    await service.requestOtp(PHONE);
    const code = extractCode(sms.lastMessage!);

    await service.verifyOtp(PHONE, code);
    await expect(service.verifyOtp(PHONE, code)).rejects.toMatchObject({ code: 'OTP_INVALID' });
  });

  it('a second verify for an already-verified phone reuses the existing customer row rather than creating a duplicate', async () => {
    await service.requestOtp(PHONE);
    const first = await service.verifyOtp(PHONE, extractCode(sms.lastMessage!));

    await service.requestOtp(PHONE);
    const second = await service.verifyOtp(PHONE, extractCode(sms.lastMessage!));

    expect(second.customer.id).toBe(first.customer.id);
  });

  it('rejects an incorrect code and increments the attempt count', async () => {
    await service.requestOtp(PHONE);
    await expect(service.verifyOtp(PHONE, '000000')).rejects.toMatchObject({ code: 'OTP_INVALID' });

    const stored = await repos.otpCodes.findActiveForPhone(PHONE);
    expect(stored?.attempts).toBe(1);
  });

  it('locks out further attempts once the max attempt count is reached, even with the correct code', async () => {
    await service.requestOtp(PHONE);
    const code = extractCode(sms.lastMessage!);

    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      await service.verifyOtp(PHONE, '000000').catch(() => undefined);
    }

    await expect(service.verifyOtp(PHONE, code)).rejects.toMatchObject({ code: 'OTP_MAX_ATTEMPTS' });
  });

  it('rejects verification for a phone with no outstanding code the same way as a wrong code -- no signal about whether the phone has ever requested one', async () => {
    await expect(service.verifyOtp('+19995550000', '123456')).rejects.toMatchObject({
      code: 'OTP_INVALID',
    });
  });

  it('verifyOtp is deterministic about the SmsService boundary -- send() is called exactly once per requestOtp, never during verify', async () => {
    const sendSpy = vi.spyOn(sms, 'send');
    await service.requestOtp(PHONE);
    await service.verifyOtp(PHONE, extractCode(sms.lastMessage!));
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});
