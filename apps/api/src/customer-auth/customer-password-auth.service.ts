import type { Db } from '../db/client';
import { PASSWORD_ITERATIONS } from '../auth/password';
import type { Pbkdf2Worker } from '../auth/pbkdf2-worker';
import { CustomerAuthEventRepository } from '../repositories/customer-auth-event.repository';
import { CustomerCredentialRepository } from '../repositories/customer-credential.repository';
import { CustomerRepository } from '../repositories/customer.repository';
import type { CustomerSessionAuthMethod } from '../db/schema';
import {
  PASSWORD_MAX_LENGTH_DEFAULT,
  checkPasswordPolicy,
  isHashableLength,
  normalizePassword,
  type PasswordPolicyViolation,
} from './customer-password-policy';
import type { CustomerSessionService, IssuedSession } from './customer-session.service';
import { customerMayHaveSession } from './session-policy';

/**
 * CUSTOMER-AUTH-01D-4a: password registration, sign-in, recovery, enrollment
 * and change. The DOMAIN layer only.
 *
 * NOT exposed over HTTP and not mounted anywhere: the routes are 01D-4b, and
 * rate limiting (01D-5) must exist before any route that accepts a password is
 * switched on. Nothing in the running API calls this class.
 *
 * Properties this layer guarantees (01A section 6.3, 01C):
 *  - Phone ownership is an INPUT, never assumed. Every flow that creates or
 *    resets a credential needs a fresh `VerifiedPhoneProof`.
 *  - Password sign-in answers one generic failure for an unknown phone, a
 *    customer with no password, a suspended customer, and a wrong password, and
 *    performs exactly one hash verification on every path so the timing class
 *    does not reveal which it was.
 *  - Oversized passwords are refused BEFORE hashing, so a request cannot force
 *    unbounded PBKDF2 work.
 *  - Passwords are NFKC-normalized before hashing and verifying.
 *  - The raw password is never stored, logged or placed in an event.
 */

/**
 * Evidence that the caller JUST verified this phone (a Twilio Verify approval
 * or a local OTP check). It is constructed only by the OTP verification layer
 * and checked here for freshness, so a stale or replayed proof cannot reset a
 * password. This is defense in depth, not a cryptographic proof: TypeScript
 * cannot stop other code from building one, so only the OTP layer may.
 */
export type VerifiedPhoneProof = {
  readonly phone: string;
  readonly verifiedAt: Date;
  readonly source: 'twilio_verify' | 'local_otp';
};

export type CustomerPasswordAuthConfig = {
  /** CA-05, an owner decision. Required: no default is invented here. */
  passwordMinLength: number;
  passwordMaxLength?: number;
  /** How old a phone proof may be, in seconds. Required. */
  phoneProofMaxAgeSeconds: number;
  /** PBKDF2 work factor for NEW hashes. Defaults to the repository standard. */
  passwordIterations?: number;
  now?: () => Date;
};

export type PhoneFlowFailure = 'proof_invalid' | 'customer_inactive' | 'phone_unavailable';

export type SignInWithVerifiedPhoneResult =
  | {
      ok: true;
      session: IssuedSession;
      customerId: string;
      isNewCustomer: boolean;
      hasPassword: boolean;
    }
  | { ok: false; reason: PhoneFlowFailure };

export type PasswordSetupResult =
  | { ok: true; session: IssuedSession; customerId: string; isNewCustomer: boolean }
  | { ok: false; reason: PhoneFlowFailure | 'already_registered' }
  | { ok: false; reason: 'policy'; violations: PasswordPolicyViolation[] };

export type PasswordLoginResult =
  { ok: true; session: IssuedSession } | { ok: false; kind: 'invalid' };

export type SessionPasswordResult =
  | { ok: true }
  | { ok: false; reason: 'policy'; violations: PasswordPolicyViolation[] }
  | {
      ok: false;
      reason:
        'not_authorized' | 'step_up_required' | 'already_set' | 'no_credential' | 'invalid_current';
    };

const PHONE_FORMAT = /^\+[1-9][0-9]{6,14}$/;

export class CustomerPasswordAuthService {
  private readonly clock: () => Date;
  private readonly iterations: number;
  private readonly maxLength: number;
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly db: Db,
    private readonly sessions: CustomerSessionService,
    private readonly hasher: Pbkdf2Worker,
    private readonly config: CustomerPasswordAuthConfig,
  ) {
    if (!Number.isInteger(config.passwordMinLength) || config.passwordMinLength <= 0) {
      throw new Error('passwordMinLength must be a positive integer.');
    }
    if (!Number.isInteger(config.phoneProofMaxAgeSeconds) || config.phoneProofMaxAgeSeconds <= 0) {
      throw new Error('phoneProofMaxAgeSeconds must be a positive integer.');
    }
    this.clock = config.now ?? (() => new Date());
    this.iterations = config.passwordIterations ?? PASSWORD_ITERATIONS;
    this.maxLength = config.passwordMaxLength ?? PASSWORD_MAX_LENGTH_DEFAULT;
  }

  private repos() {
    return {
      customers: new CustomerRepository(this.db),
      credentials: new CustomerCredentialRepository(this.db),
      events: new CustomerAuthEventRepository(this.db),
    };
  }

  private proofIsFresh(proof: VerifiedPhoneProof, now: Date): boolean {
    if (!PHONE_FORMAT.test(proof.phone)) return false;
    const age = now.getTime() - proof.verifiedAt.getTime();
    return age >= 0 && age <= this.config.phoneProofMaxAgeSeconds * 1000;
  }

  private policy(password: unknown, phone: string) {
    return checkPasswordPolicy(
      password,
      { phone },
      { minLength: this.config.passwordMinLength, maxLength: this.maxLength },
    );
  }

  /** A real hash at the production work factor, so an unknown phone costs the same as a known one. */
  private dummy(): Promise<string> {
    this.dummyHash ??= this.hasher.hash(
      'echogrid-dummy-credential-not-a-password',
      this.iterations,
    );
    return this.dummyHash;
  }

  /**
   * The new-model equivalent of today's OTP sign-in (01C Flow A). Finds or
   * creates the customer (race-safe), then opens a session. Reports whether the
   * customer already has a password so the caller can offer to create one.
   */
  async signInWithVerifiedPhone(
    proof: VerifiedPhoneProof,
    options: { deviceLabel?: string | null; sourceHint?: string | null } = {},
  ): Promise<SignInWithVerifiedPhoneResult> {
    const now = this.clock();
    if (!this.proofIsFresh(proof, now)) return { ok: false, reason: 'proof_invalid' };
    const r = this.repos();

    const found = await r.customers.createIfAbsent({
      phone: proof.phone,
      phoneVerifiedAt: proof.verifiedAt,
    });
    if (!found.customer) return { ok: false, reason: 'phone_unavailable' };
    if (!customerMayHaveSession({ status: found.customer.status, isDeleted: false })) {
      return { ok: false, reason: 'customer_inactive' };
    }
    const established = await this.sessions.establishSession({
      customerId: found.customer.id,
      authMethod: 'otp',
      ...options,
    });
    if (!established.ok) return { ok: false, reason: 'customer_inactive' };
    if (found.created) {
      await this.bestEffort(r.events, {
        customerId: found.customer.id,
        eventType: 'registration_completed',
        outcome: 'success',
        now,
      });
    }
    return {
      ok: true,
      session: established.session,
      customerId: found.customer.id,
      isNewCustomer: found.created,
      hasPassword: await r.credentials.exists(found.customer.id),
    };
  }

  /**
   * Registration with a password, after phone verification. An existing OTP-only
   * customer attaches a first password to the SAME identity (01C). If a password
   * already exists the call is refused and changes nothing: that is a recovery.
   */
  async registerWithPassword(
    proof: VerifiedPhoneProof,
    password: string,
    options: { deviceLabel?: string | null; sourceHint?: string | null } = {},
  ): Promise<PasswordSetupResult> {
    const now = this.clock();
    if (!this.proofIsFresh(proof, now)) return { ok: false, reason: 'proof_invalid' };
    const policy = this.policy(password, proof.phone);
    if (!policy.ok) return { ok: false, reason: 'policy', violations: policy.violations };
    const r = this.repos();

    const found = await r.customers.createIfAbsent({
      phone: proof.phone,
      phoneVerifiedAt: proof.verifiedAt,
    });
    if (!found.customer) return { ok: false, reason: 'phone_unavailable' };
    if (!customerMayHaveSession({ status: found.customer.status, isDeleted: false })) {
      return { ok: false, reason: 'customer_inactive' };
    }
    if (await r.credentials.exists(found.customer.id))
      return { ok: false, reason: 'already_registered' };

    // Hash BEFORE any transaction so the expensive work never holds database locks.
    const passwordHash = await this.hasher.hash(normalizePassword(password), this.iterations);
    const created = await r.credentials.create({
      customerId: found.customer.id,
      passwordHash,
      now,
    });
    if (!created) return { ok: false, reason: 'already_registered' }; // lost a race to another device

    await this.bestEffort(r.events, {
      customerId: found.customer.id,
      eventType: 'password_set',
      outcome: 'success',
      now,
    });
    if (found.created) {
      await this.bestEffort(r.events, {
        customerId: found.customer.id,
        eventType: 'registration_completed',
        outcome: 'success',
        now,
      });
    }
    const established = await this.sessions.establishSession({
      customerId: found.customer.id,
      authMethod: 'otp',
      ...options,
    });
    if (!established.ok) return { ok: false, reason: 'customer_inactive' };
    return {
      ok: true,
      session: established.session,
      customerId: found.customer.id,
      isNewCustomer: found.created,
    };
  }

  /**
   * Forgot password, after phone verification. In one transaction the password
   * is replaced (or first set), the legacy cutoff advances and EVERY existing
   * session is revoked. A fresh `recovery` session is then opened. An unknown
   * phone that was just verified becomes a new customer, exactly as sign-in does.
   */
  async recoverPassword(
    proof: VerifiedPhoneProof,
    newPassword: string,
    options: { deviceLabel?: string | null; sourceHint?: string | null } = {},
  ): Promise<PasswordSetupResult> {
    const now = this.clock();
    if (!this.proofIsFresh(proof, now)) return { ok: false, reason: 'proof_invalid' };
    const policy = this.policy(newPassword, proof.phone);
    if (!policy.ok) return { ok: false, reason: 'policy', violations: policy.violations };
    const r = this.repos();

    const found = await r.customers.createIfAbsent({
      phone: proof.phone,
      phoneVerifiedAt: proof.verifiedAt,
    });
    if (!found.customer) return { ok: false, reason: 'phone_unavailable' };

    const passwordHash = await this.hasher.hash(normalizePassword(newPassword), this.iterations);
    const done = await this.sessions.completeRecovery({
      customerId: found.customer.id,
      passwordHash,
    });
    if (!done.ok) return { ok: false, reason: 'customer_inactive' };

    if (found.created) {
      await this.bestEffort(r.events, {
        customerId: found.customer.id,
        eventType: 'registration_completed',
        outcome: 'success',
        now,
      });
    }
    const established = await this.sessions.establishSession({
      customerId: found.customer.id,
      authMethod: 'recovery',
      ...options,
    });
    if (!established.ok) return { ok: false, reason: 'customer_inactive' };
    return {
      ok: true,
      session: established.session,
      customerId: found.customer.id,
      isNewCustomer: found.created,
    };
  }

  /**
   * Phone plus password. One generic failure for every reason, one hash
   * verification on every path (a dummy hash stands in when there is nothing
   * real to check), and no work at all for an oversized or malformed input.
   */
  async loginWithPassword(input: {
    phone: string;
    password: string;
    deviceLabel?: string | null;
    sourceHint?: string | null;
  }): Promise<PasswordLoginResult> {
    const invalid = { ok: false, kind: 'invalid' } as const;
    if (typeof input.phone !== 'string' || !PHONE_FORMAT.test(input.phone)) return invalid;
    if (
      typeof input.password !== 'string' ||
      input.password.length === 0 ||
      !isHashableLength(input.password, this.maxLength)
    ) {
      return invalid;
    }
    const now = this.clock();
    const r = this.repos();

    const customer = await r.customers.findByPhone(input.phone);
    const credential = customer ? await r.credentials.findByCustomerId(customer.id) : undefined;
    const storedHash = credential?.passwordHash ?? (await this.dummy());
    const matches = await this.hasher.verify(normalizePassword(input.password), storedHash);

    if (!customer || !credential) return invalid;
    if (!matches) {
      await this.bestEffort(r.events, {
        customerId: customer.id,
        eventType: 'password_login_failed',
        outcome: 'failure',
        reasonCode: 'bad_password',
        now,
      });
      return invalid;
    }
    if (!customerMayHaveSession({ status: customer.status, isDeleted: false })) {
      await this.bestEffort(r.events, {
        customerId: customer.id,
        eventType: 'password_login_failed',
        outcome: 'blocked',
        reasonCode: 'customer_inactive',
        now,
      });
      return invalid;
    }

    const established = await this.sessions.establishSession({
      customerId: customer.id,
      authMethod: 'password' satisfies CustomerSessionAuthMethod,
      ...(input.deviceLabel !== undefined ? { deviceLabel: input.deviceLabel } : {}),
      ...(input.sourceHint !== undefined ? { sourceHint: input.sourceHint } : {}),
    });
    if (!established.ok) return invalid;
    await r.credentials.markVerified(customer.id, now);
    await this.bestEffort(r.events, {
      customerId: customer.id,
      sessionId: established.session.sessionId,
      eventType: 'password_login_succeeded',
      outcome: 'success',
      now,
    });
    return { ok: true, session: established.session };
  }

  /** First password from inside a live session that has a fresh step-up. */
  async enrollPassword(input: {
    customerId: string;
    sessionId: string;
    password: string;
  }): Promise<SessionPasswordResult> {
    const customer = await this.repos().customers.findById(input.customerId);
    if (!customer) return { ok: false, reason: 'not_authorized' };
    const policy = this.policy(input.password, customer.phone);
    if (!policy.ok) return { ok: false, reason: 'policy', violations: policy.violations };
    const passwordHash = await this.hasher.hash(normalizePassword(input.password), this.iterations);
    return this.sessions.enrollPassword({
      customerId: input.customerId,
      sessionId: input.sessionId,
      passwordHash,
    });
  }

  /**
   * Change with proof of the CURRENT password. A correct current password is
   * itself a fresh re-verification, so it records the step-up before the change.
   */
  async changePassword(input: {
    customerId: string;
    sessionId: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<SessionPasswordResult> {
    const r = this.repos();
    const customer = await r.customers.findById(input.customerId);
    if (!customer) return { ok: false, reason: 'not_authorized' };
    if (
      typeof input.currentPassword !== 'string' ||
      !isHashableLength(input.currentPassword, this.maxLength)
    ) {
      return { ok: false, reason: 'invalid_current' };
    }
    const policy = this.policy(input.newPassword, customer.phone);
    if (!policy.ok) return { ok: false, reason: 'policy', violations: policy.violations };

    const credential = await r.credentials.findByCustomerId(input.customerId);
    if (!credential) return { ok: false, reason: 'no_credential' };
    const ok = await this.hasher.verify(
      normalizePassword(input.currentPassword),
      credential.passwordHash,
    );
    if (!ok) {
      await this.bestEffort(r.events, {
        customerId: input.customerId,
        sessionId: input.sessionId,
        eventType: 'step_up_failed',
        outcome: 'failure',
        reasonCode: 'bad_current_password',
        now: this.clock(),
      });
      return { ok: false, reason: 'invalid_current' };
    }
    if (
      !(await this.sessions.recordStepUp({
        customerId: input.customerId,
        sessionId: input.sessionId,
      }))
    ) {
      return { ok: false, reason: 'not_authorized' };
    }
    const passwordHash = await this.hasher.hash(
      normalizePassword(input.newPassword),
      this.iterations,
    );
    return this.sessions.changePassword({
      customerId: input.customerId,
      sessionId: input.sessionId,
      passwordHash,
    });
  }

  /** Audit writes that describe an outcome already decided must not turn it into an error. */
  private async bestEffort(
    events: CustomerAuthEventRepository,
    event: Parameters<CustomerAuthEventRepository['append']>[0],
  ): Promise<void> {
    try {
      await events.append(event);
    } catch {
      /* intentionally not fatal */
    }
  }
}
