import type { Repositories } from '../repositories';
import type { Bindings } from '../config/env';
import { AppError } from '../lib/errors';
import type { SmsService } from './sms.service';
import {
  generateOtpCode,
  hashOtpCode,
  verifyOtpCode,
  otpExpiresAt,
  OTP_MAX_ATTEMPTS,
  OTP_REQUEST_COOLDOWN_SECONDS,
} from './otp';
import { signCustomerAccessToken } from './customer-jwt';
import type { Customer } from '../repositories/customer.repository';

const CUSTOMER_AUTH_ERROR_STATUS = {
  OTP_COOLDOWN: 429,
  OTP_INVALID: 401,
  OTP_MAX_ATTEMPTS: 429,
  CUSTOMER_SUSPENDED: 401,
} as const;

type CustomerAuthErrorCode = keyof typeof CUSTOMER_AUTH_ERROR_STATUS;

/** Extends the shared AppError (same pattern as auth/auth.service.ts's
 * AuthError) so customer-auth failures flow through the same global error
 * handler as every other feature module. */
export class CustomerAuthError extends AppError {
  constructor(message: string, code: CustomerAuthErrorCode) {
    super(message, CUSTOMER_AUTH_ERROR_STATUS[code], code);
  }
}

export interface CustomerAuthResult {
  accessToken: string;
  customer: Customer;
}

/**
 * Customer identity + OTP verification business logic. Constructor-injected
 * with repos, the SMS service, and the customer JWT secret -- mirrors
 * AuthService's shape so the two systems stay easy to compare, even though
 * they are deliberately NOT unified (customers are a separate identity
 * concept from staff users, see db/schema/customers.ts).
 */
export class CustomerAuthService {
  constructor(
    private readonly repos: Pick<Repositories, 'customers' | 'otpCodes'>,
    private readonly sms: SmsService,
    private readonly secrets: Pick<Bindings, 'CUSTOMER_JWT_SECRET'>,
  ) {}

  /** Issues a new OTP and sends it via SMS. Silent on an unknown phone (no
   * "does this number exist" signal) since first-ever verify precedes any
   * customer row existing -- there is nothing to enumerate either way. */
  async requestOtp(phone: string): Promise<void> {
    const latest = await this.repos.otpCodes.findLatestForPhone(phone);
    // Only an unconsumed recent code triggers the cooldown: it exists to
    // rate-limit SMS sends from repeated *unverified* requests. Once a code
    // has been consumed (which requires a successful verify -- proof of phone
    // ownership), a fresh request is a legitimate re-authentication, not spam,
    // and must not be blocked (e.g. a returning customer re-verifying).
    if (latest && !latest.consumedAt) {
      const secondsSinceLastRequest = (Date.now() - latest.createdAt.getTime()) / 1000;
      if (secondsSinceLastRequest < OTP_REQUEST_COOLDOWN_SECONDS) {
        throw new CustomerAuthError(
          'Please wait before requesting another code.',
          'OTP_COOLDOWN',
        );
      }
    }

    const code = generateOtpCode();
    await this.repos.otpCodes.create({
      phone,
      codeHash: await hashOtpCode(code),
      expiresAt: otpExpiresAt(),
    });

    await this.sms.send(phone, `Your Echo Grid Feedback verification code is ${code}. It expires in 10 minutes.`);
  }

  /**
   * Verifies a code and issues a customer session. Find-or-creates the
   * customer row on first successful verify (a phone number only becomes a
   * customers row once it's actually confirmed to be reachable/owned).
   */
  async verifyOtp(phone: string, code: string): Promise<CustomerAuthResult> {
    const active = await this.repos.otpCodes.findActiveForPhone(phone);
    if (!active) {
      throw new CustomerAuthError('Code is invalid or has expired.', 'OTP_INVALID');
    }
    if (active.attempts >= OTP_MAX_ATTEMPTS) {
      throw new CustomerAuthError(
        'Too many incorrect attempts. Please request a new code.',
        'OTP_MAX_ATTEMPTS',
      );
    }

    const valid = await verifyOtpCode(code, active.codeHash);
    if (!valid) {
      await this.repos.otpCodes.incrementAttempts(active.id);
      throw new CustomerAuthError('Code is invalid or has expired.', 'OTP_INVALID');
    }
    await this.repos.otpCodes.markConsumed(active.id);

    let customer = await this.repos.customers.findByPhone(phone);
    if (!customer) {
      customer = await this.repos.customers.create({ phone, phoneVerifiedAt: new Date() });
    } else {
      if (customer.status !== 'active') {
        throw new CustomerAuthError('This account is not active.', 'CUSTOMER_SUSPENDED');
      }
      if (!customer.phoneVerifiedAt) {
        customer = (await this.repos.customers.markPhoneVerified(customer.id)) ?? customer;
      }
    }

    const accessToken = await signCustomerAccessToken(customer.id, this.secrets.CUSTOMER_JWT_SECRET);
    return { accessToken, customer };
  }
}
