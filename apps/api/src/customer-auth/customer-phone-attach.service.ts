import { AppError } from '../lib/errors';
import { normalizeE164 } from '../lib/phone';
import { maskPhone } from '../loyalty/customer-lookup.service';
import type { CustomerAuthService } from './customer-auth.service';
import type { TwilioVerifyService } from './twilio-verify.service';
import type { CustomerAuthEventRepository } from '../repositories/customer-auth-event.repository';
import type { CustomerRepository } from '../repositories/customer.repository';

/**
 * CUSTOMER-PHONE-01 stage 4: an already signed-in customer proves ownership of a phone number and it becomes their
 * VERIFIED number. First to verify owns it (the database allows one verified holder per number); a number someone else has
 * already verified is refused. Proving a number links it to the SIGNED-IN customer only: it never signs anyone in, never
 * takes over another account, and an unverified number typed at registration proves nothing until this flow completes.
 *
 * Abuse controls (starting estimates, for the owner to tune): a per-number cooldown and code expiry and attempt cap from the
 * OTP layer, plus caps per customer per day on requested codes and on failed checks. Every step is recorded in the
 * customer auth audit trail (never the number or the code).
 *
 * Changing an already verified number is deliberately NOT supported here: replacing the verified number of an account
 * needs the step-up policy (owner decision pending), so it is refused with a clear code until then.
 */
export const PHONE_ATTACH_MAX_REQUESTS_PER_DAY = 5;
export const PHONE_ATTACH_MAX_FAILURES_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The provider of codes: local OTP rows (development and tests) or Twilio Verify (production). No live send is made here. */
export interface PhoneProofPort {
  request(phone: string): Promise<void>;
  /** true = ownership proven; false = wrong or expired code. Throws AppError for lockouts (too many attempts). */
  check(phone: string, code: string): Promise<boolean>;
}

export function createLocalPhoneProof(auth: Pick<CustomerAuthService, 'requestOtp' | 'consumeOtp'>): PhoneProofPort {
  return {
    request: (phone) => auth.requestOtp(phone),
    check: async (phone, code) => {
      try {
        await auth.consumeOtp(phone, code);
        return true;
      } catch (error) {
        if (error instanceof AppError && error.code === 'OTP_INVALID') return false;
        throw error;
      }
    },
  };
}

export function createTwilioPhoneProof(twilio: Pick<TwilioVerifyService, 'request' | 'check'>): PhoneProofPort {
  return { request: (phone) => twilio.request(phone), check: (phone, code) => twilio.check(phone, code) };
}

export type PhoneStatus = { phoneMasked: string | null; verified: boolean };

export class CustomerPhoneAttachService {
  constructor(
    private readonly deps: {
      customers: Pick<CustomerRepository, 'findById' | 'claimVerifiedPhone'>;
      events: Pick<CustomerAuthEventRepository, 'append' | 'countForCustomerSince'>;
      proof: PhoneProofPort;
      now?: () => Date;
    },
  ) {}

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async eligibleCustomer(customerId: string) {
    const customer = await this.deps.customers.findById(customerId);
    if (!customer || customer.status !== 'active') {
      throw new AppError('Customer account is not available.', 409, 'CUSTOMER_NOT_AVAILABLE');
    }
    return customer;
  }

  private parse(raw: unknown): string {
    const phone = normalizeE164(raw);
    if (!phone) throw new AppError('Enter the phone number with its country code, for example +15551234567.', 400, 'INVALID_PHONE');
    return phone;
  }

  private assertCanAttach(customer: { phone: string | null; phoneVerifiedAt: Date | null }, phone: string) {
    if (customer.phone && customer.phoneVerifiedAt) {
      throw customer.phone === phone
        ? new AppError('This phone number is already verified.', 409, 'PHONE_ALREADY_VERIFIED')
        : new AppError('Changing a verified phone number is not available yet.', 409, 'PHONE_CHANGE_NOT_SUPPORTED');
    }
  }

  private record(customerId: string, eventType: 'otp_requested' | 'otp_verified' | 'otp_failed', outcome: 'success' | 'failure' | 'blocked', reasonCode: string) {
    return this.deps.events
      .append({ customerId, eventType, outcome, reasonCode, metadata: { surface: 'phone_attach' }, now: this.now() })
      .catch(() => undefined);
  }

  async status(customerId: string): Promise<PhoneStatus> {
    const customer = await this.eligibleCustomer(customerId);
    return {
      phoneMasked: customer.phone ? maskPhone(customer.phone) : null,
      verified: Boolean(customer.phone && customer.phoneVerifiedAt),
    };
  }

  /** Sends a code to the number. The same answer for any well-formed number: nothing about other accounts is revealed here. */
  async requestCode(customerId: string, rawPhone: unknown): Promise<void> {
    const phone = this.parse(rawPhone);
    const customer = await this.eligibleCustomer(customerId);
    this.assertCanAttach(customer, phone);
    const since = new Date(this.now().getTime() - DAY_MS);
    const requested = await this.deps.events.countForCustomerSince({
      customerId, eventType: 'otp_requested', reasonCode: 'phone_attach_requested', since,
    });
    if (requested >= PHONE_ATTACH_MAX_REQUESTS_PER_DAY) {
      await this.record(customerId, 'otp_requested', 'blocked', 'phone_attach_daily_cap');
      throw new AppError('Too many codes requested today. Try again tomorrow.', 429, 'PHONE_ATTACH_LIMITED');
    }
    await this.deps.proof.request(phone);
    await this.record(customerId, 'otp_requested', 'success', 'phone_attach_requested');
  }

  /** Checks the code and, if it proves the number, makes it this customer's verified phone. */
  async verifyCode(customerId: string, rawPhone: unknown, code: unknown): Promise<PhoneStatus> {
    const phone = this.parse(rawPhone);
    if (typeof code !== 'string' || !/^[0-9]{4,10}$/.test(code)) {
      throw new AppError('Code is invalid or has expired.', 401, 'OTP_INVALID');
    }
    const customer = await this.eligibleCustomer(customerId);
    this.assertCanAttach(customer, phone);
    const since = new Date(this.now().getTime() - DAY_MS);
    const failures = await this.deps.events.countForCustomerSince({
      customerId, eventType: 'otp_failed', reasonCode: 'phone_attach_failed', since,
    });
    if (failures >= PHONE_ATTACH_MAX_FAILURES_PER_DAY) {
      await this.record(customerId, 'otp_failed', 'blocked', 'phone_attach_failure_cap');
      throw new AppError('Too many incorrect codes today. Try again tomorrow.', 429, 'PHONE_ATTACH_LIMITED');
    }

    let proven: boolean;
    try {
      proven = await this.deps.proof.check(phone, code);
    } catch (error) {
      await this.record(customerId, 'otp_failed', 'failure', 'phone_attach_failed');
      throw error;
    }
    if (!proven) {
      await this.record(customerId, 'otp_failed', 'failure', 'phone_attach_failed');
      throw new AppError('Code is invalid or has expired.', 401, 'OTP_INVALID');
    }

    const claimed = await this.deps.customers.claimVerifiedPhone(customerId, phone);
    if (!claimed.ok) {
      await this.record(customerId, 'otp_failed', 'blocked', claimed.reason === 'taken' ? 'phone_attach_taken' : 'phone_attach_failed');
      throw claimed.reason === 'taken'
        ? new AppError('This phone number is already verified on another account.', 409, 'PHONE_TAKEN')
        : new AppError('Customer account is not available.', 409, 'CUSTOMER_NOT_AVAILABLE');
    }
    await this.record(customerId, 'otp_verified', 'success', 'phone_attach_completed');
    return { phoneMasked: maskPhone(phone), verified: true };
  }
}
